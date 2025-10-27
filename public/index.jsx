import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, doc, setDoc, collection, query, onSnapshot } from 'firebase/firestore';

// --- FIREBASE SETUP ---
// Global variables provided by the Canvas environment
const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
const firebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : {};
const initialAuthToken = typeof __initial_auth_token !== 'undefined' ? __initialAuthToken : null;

// The official start date of the challenge (November 1st, 2025)
const CHALLENGE_START_DATE = new Date('2025-11-01T00:00:00');

// Archetype structure for the daily journal
const ARCHETYPES = [
  { key: 'king', title: 'King', prompt: 'Today I sharpened my masculine King by...' },
  { key: 'priest', title: 'Priest', prompt: 'Today I practiced my masculine Priest by...' },
  { key: 'poet', title: 'Poet', prompt: 'Today I showed my masculine Poet by...' },
  { key: 'jester', title: 'Jester', prompt: 'Today I fed my masculine Jester by...' },
  { key: 'warrior', title: 'Warrior', prompt: 'Today I trained my masculine Warrior by...' },
];

// Utility function to get the current day of the challenge (1 to 30)
const getCurrentChallengeDay = (startDate) => {
    const today = new Date();
    // Reset time components for accurate day calculation
    today.setHours(0, 0, 0, 0);
    startDate.setHours(0, 0, 0, 0);

    const timeDiff = today.getTime() - startDate.getTime();
    const dayDiff = Math.ceil(timeDiff / (1000 * 3600 * 24)) + 1; // +1 to make Day 0 the start day
    return Math.min(Math.max(1, dayDiff), 30); // Clamp between 1 and 30
};

// --- CORE APP COMPONENT ---

const App = () => {
  const [db, setDb] = useState(null);
  const [auth, setAuth] = useState(null);
  const [userId, setUserId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [logs, setLogs] = useState([]); // Array of { day: number, date: string, entries: {} }
  const [currentPage, setCurrentPage] = useState('home'); // 'home', 'log', 'history'
  const [dailyLog, setDailyLog] = useState({});
  const [hasLoggedToday, setHasLoggedToday] = useState(false);

  // Gemini State
  const [geminiLoading, setGeminiLoading] = useState(false);
  const [geminiError, setGeminiError] = useState(null);
  const [synthesisResult, setSynthesisResult] = useState(null);
  const [analysisResult, setAnalysisResult] = useState(null);
  const [selectedArchetypeForAnalysis, setSelectedArchetypeForAnalysis] = useState('king');

  // Helper for displaying custom messages instead of browser alerts
  const [appMessage, setAppMessage] = useState(null);
  const showMessage = (message, type = 'info') => {
      setAppMessage({ message, type });
      setTimeout(() => setAppMessage(null), 5000);
  };


  // --- GEMINI API SETUP ---
  const GEMINI_API_KEY = ""; // Key is provided by Canvas
  const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent";

  const callGemini = useCallback(async (systemPrompt, userQuery, maxRetries = 3) => {
    setGeminiError(null); 
    setGeminiLoading(true);
    let resultText = null;

    const payload = {
        contents: [{ parts: [{ text: userQuery }] }],
        systemInstruction: { parts: [{ text: systemPrompt }] },
    };

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            const delay = Math.pow(2, attempt) * 1000;
            if (attempt > 0) await new Promise(resolve => setTimeout(resolve, delay));

            const response = await fetch(`${GEMINI_API_URL}?key=${GEMINI_API_KEY}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                if (response.status === 429 && attempt < maxRetries - 1) {
                    continue; // Retry on Rate Limit Exceeded
                }
                throw new Error(`API error: ${response.statusText}`);
            }

            const result = await response.json();
            const text = result.candidates?.[0]?.content?.parts?.[0]?.text;

            if (text) {
                resultText = text;
                break; // Success
            } else {
                throw new Error("Gemini response was empty or malformed.");
            }
        } catch (e) {
            console.error(`Gemini API attempt ${attempt + 1} failed:`, e);
            if (attempt === maxRetries - 1) {
                setGeminiError(`Gemini feature failed after ${maxRetries} attempts.`);
                setGeminiLoading(false);
                return null;
            }
        }
    }
    setGeminiLoading(false);
    return resultText;
  }, []);

  // --- CORE APP LOGIC ---

  // Initialize Firebase and Auth
  useEffect(() => {
    try {
      if (Object.keys(firebaseConfig).length === 0) {
        throw new Error("Firebase config not available. Check environment setup.");
      }

      const app = initializeApp(firebaseConfig);
      const firestore = getFirestore(app);
      const firebaseAuth = getAuth(app);
      setDb(firestore);
      setAuth(firebaseAuth);

      const authenticateUser = async () => {
        if (initialAuthToken) {
          await signInWithCustomToken(firebaseAuth, initialAuthToken);
        } else {
          await signInAnonymously(firebaseAuth);
        }
      };

      const unsubscribe = onAuthStateChanged(firebaseAuth, (user) => {
        if (user) {
          setUserId(user.uid);
          setLoading(false);
        } else {
          authenticateUser().catch(err => {
            console.error("Authentication Error:", err);
            setError("Failed to initialize authentication.");
            setLoading(false);
          });
        }
      });

      return () => unsubscribe();
    } catch (e) {
      console.error("Firebase Initialization Error:", e);
      setError(e.message);
      setLoading(false);
    }
  }, []);

  // Firestore Listener for Daily Logs
  useEffect(() => {
    if (!db || !userId) return;

    const logsCollectionRef = collection(db, `artifacts/${appId}/users/${userId}/challenge_logs`);
    const q = query(logsCollectionRef);

    const unsubscribe = onSnapshot(q, (snapshot) => {
        const fetchedLogs = snapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data(),
            day: parseInt(doc.id.replace('Day-', ''), 10) // Parse Day-X ID to number
        }));

        fetchedLogs.sort((a, b) => a.day - b.day);

        setLogs(fetchedLogs);

        const todayDate = new Date().toLocaleDateString('en-US');
        const logged = fetchedLogs.some(log => log.date === todayDate);
        setHasLoggedToday(logged);
        
        if (!logged) {
            const initialLog = ARCHETYPES.reduce((acc, current) => {
                acc[current.key] = '';
                return acc;
            }, {});
            setDailyLog(initialLog);
            setSynthesisResult(null); // Reset synthesis if logging a new day
        } else {
             setDailyLog({});
        }
    }, (e) => {
        console.error("Firestore Snapshot Error:", e);
        setError("Failed to fetch challenge logs.");
    });

    return () => unsubscribe();
  }, [db, userId]);

  // Derived State
  const challengeDay = useMemo(() => getCurrentChallengeDay(CHALLENGE_START_DATE), []);
  const isChallengeActive = challengeDay >= 1 && challengeDay <= 30;

  const handleInputChange = (key, value) => {
    setDailyLog(prev => ({ ...prev, [key]: value }));
  };

  const handleLogSubmit = async () => {
    if (!db || !userId) {
      setError("App not initialized. Cannot submit.");
      return;
    }

    const docId = `Day-${challengeDay}`;
    const dateString = new Date().toLocaleDateString('en-US');
    
    // Check if any field is filled out
    const isAnyFieldFilled = Object.values(dailyLog).some(val => val.trim() !== '');

    if (!isAnyFieldFilled) {
        showMessage("Please fill out at least one archetype reflection before submitting.", 'error');
        return;
    }

    const logEntry = {
      date: dateString,
      day: challengeDay,
      entries: dailyLog,
      timestamp: Date.now(),
      userId: userId, 
    };

    try {
      // 1. Private Log Submission
      const docRef = doc(db, `artifacts/${appId}/users/${userId}/challenge_logs`, docId);
      await setDoc(docRef, logEntry);
      
      // 2. Public Status Submission (for Brother Iron accountability)
      const publicLogRef = doc(db, `artifacts/${appId}/public/data/daily_status`, `${userId}-${docId}`);
      await setDoc(publicLogRef, { 
          userId, 
          day: challengeDay, 
          date: dateString, 
          status: 'Complete', 
          timestamp: logEntry.timestamp 
        });

      showMessage(`Success! Day ${challengeDay} logged.`, 'success');
      setDailyLog({});
      setCurrentPage('home');

    } catch (e) {
      console.error("Error writing document: ", e);
      setError("Failed to save your log. Please try again.");
    }
  };

  // --- GEMINI HANDLERS ---

  const handleSynthesis = async () => {
    const isAnyFieldFilled = Object.values(dailyLog).some(val => val.trim() !== '');
    if (!isAnyFieldFilled) {
        showMessage("Please fill out your entries before synthesizing.", 'error');
        return;
    }

    setAnalysisResult(null); // Clear analysis result

    const logText = ARCHETYPES.map(({ title, key }) => 
        `${title} Archetype: ${dailyLog[key] || 'No entry.'}`
    ).join('\n');

    const systemPrompt = `You are the Lost Kings Challenge master. Analyze the user's daily archetype entries. Provide a response in two parts: 1. A short, powerful, single-sentence "Challenge Headline" that captures the essence of his day's work. 2. A two-sentence summary paragraph of his performance across the 5 archetypes. Format the output with bold markdown headers for 'Challenge Headline' and 'Performance Summary'.`;
    
    const userQuery = `Summarize today's 5 Archetype reflections:\n\n${logText}`;

    const result = await callGemini(systemPrompt, userQuery);
    if (result) {
        setSynthesisResult(result);
    }
  };

  const handleGrowthAnalysis = async () => {
    if (logs.length === 0) {
        setAnalysisResult("No history logs available for analysis yet.");
        return;
    }

    setSynthesisResult(null); // Clear synthesis result

    const archetypeKey = selectedArchetypeForAnalysis;
    const archetypeTitle = ARCHETYPES.find(a => a.key === archetypeKey).title;

    // Collect all entries for the selected archetype
    const allEntries = logs
      .map(log => log.entries[archetypeKey])
      .filter(entry => entry && entry.trim() !== '')
      .join('\n---\n'); // Separator for context clarity

    if (allEntries.length < 50) {
        setAnalysisResult(`Not enough data for ${archetypeTitle} analysis. Need more log entries.`);
        return;
    }

    const systemPrompt = `You are a strategic coach for the Lost Kings Challenge. Your job is to analyze the user's past actions for the "${archetypeTitle}" archetype. Based on all provided historical logs, highlight one recurring theme of consistent action and provide one highly specific, actionable suggestion for how the user can deepen his commitment to this archetype over the next week. Format your response with bold markdown headers for 'Consistent Theme' and 'Strategic Suggestion'.`;

    const userQuery = `Analyze the recurring themes and provide strategic coaching for the "${archetypeTitle}" archetype based on the following history:\n\n${allEntries}`;

    const result = await callGemini(systemPrompt, userQuery);
    if (result) {
        setAnalysisResult(result);
    }
  };


  // --- UI Components ---

  const Header = () => (
    <div className="flex justify-between items-center p-4 bg-gray-900 shadow-lg border-b border-yellow-600">
      <h1 className="text-3xl font-serif text-yellow-500 tracking-wider">Lost Kings</h1>
      <div className="flex space-x-4">
        <NavButton page="home" label="Home" icon="👑" />
        <NavButton page="log" label="Daily Forge" icon="🔥" />
        <NavButton page="history" label="Growth Log" icon="📈" />
      </div>
    </div>
  );

  const NavButton = ({ page, label, icon }) => (
    <button
      onClick={() => setCurrentPage(page)}
      className={`px-4 py-2 rounded-lg transition duration-200 text-sm font-semibold 
        ${currentPage === page 
          ? 'bg-yellow-700 text-white shadow-lg' 
          : 'bg-gray-800 text-gray-300 hover:bg-yellow-600 hover:text-white'}`
      }
    >
      <span className="mr-1">{icon}</span> {label}
    </button>
  );

  const LoadingScreen = () => (
    <div className="flex flex-col items-center justify-center h-screen bg-gray-900 text-white">
      <div className="animate-spin rounded-full h-16 w-16 border-t-2 border-b-2 border-yellow-500"></div>
      <p className="mt-4 text-xl">Forging the Connection...</p>
      {error && <p className="mt-4 text-red-500">{error}</p>}
    </div>
  );

  const AppMessage = () => {
    if (!appMessage) return null;
    const { message, type } = appMessage;
    const bgColor = type === 'success' ? 'bg-green-700' : type === 'error' ? 'bg-red-700' : 'bg-blue-700';
    return (
        <div className={`p-3 mx-6 rounded-lg text-white font-semibold ${bgColor} shadow-lg transition-opacity duration-300`}>
            {message}
        </div>
    );
  };

  const GeminiStatus = () => {
    if (!geminiLoading && !geminiError) return null;
    return (
        <div className={`p-3 mt-4 rounded-lg text-center font-semibold text-sm transition-all duration-500 
            ${geminiLoading ? 'bg-yellow-900 text-yellow-300' : geminiError ? 'bg-red-800 text-white' : ''}`}>
            {geminiLoading ? 'AI Coach Analyzing...' : `AI Error: ${geminiError}`}
        </div>
    );
  };

  // --- PAGE VIEWS ---

  const HomePage = () => {
    const statusText = hasLoggedToday 
        ? <span className="text-green-400 font-bold">LOGGED & COMPLETE</span> 
        : <span className="text-red-400 font-bold">PENDING SUBMISSION</span>;

    return (
      <div className="p-6">
        <div className="bg-gray-800 p-8 rounded-xl shadow-2xl border-t-4 border-yellow-600 mb-8">
          <h2 className="text-4xl font-bold text-yellow-400 mb-2">Iron Sharpens Iron Challenge</h2>
          <p className="text-gray-300 text-xl">The Forge of Discipline: November 1st, 2025</p>
          <div className="mt-6 text-center">
            {isChallengeActive ? (
              <>
                <div className="text-6xl font-extrabold text-white">
                  DAY <span className="text-yellow-500">{challengeDay}</span> / 30
                </div>
                <p className="text-gray-400 mt-2">The work continues. You are not the same man.</p>
              </>
            ) : (
              <div className="text-4xl text-yellow-600 font-bold">
                {challengeDay < 1 ? 'CHALLENGE PENDING' : 'CHALLENGE COMPLETE!'}
                {challengeDay < 1 && <p className="text-lg text-gray-400 mt-2">Starts Nov 1st. Prepare your mind, body, and soul.</p>}
              </div>
            )}
          </div>
        </div>

        <div className="bg-gray-700 p-6 rounded-xl shadow-xl">
          <h3 className="text-2xl font-semibold text-white mb-4 border-b border-gray-600 pb-2">Your Accountability</h3>
          <p className="text-lg text-gray-300 mb-4">
            Today's Status: {statusText}
          </p>

          <button
            onClick={() => setCurrentPage('log')}
            disabled={hasLoggedToday || !isChallengeActive}
            className={`w-full py-3 rounded-lg text-lg font-bold transition duration-300 
              ${hasLoggedToday || !isChallengeActive
                ? 'bg-gray-600 text-gray-400 cursor-not-allowed'
                : 'bg-red-700 text-white hover:bg-red-800 shadow-md hover:shadow-lg'}`
            }
          >
            {hasLoggedToday ? '✅ LOG FOR TODAY SUBMITTED' : '🔥 START DAILY FORGE'}
          </button>

           <div className="mt-6 p-4 bg-gray-800 rounded-lg text-sm">
                <p className="text-yellow-500 font-semibold">Your Brother Iron ID (For Accountability):</p>
                <p className="text-gray-300 break-all">{userId}</p>
            </div>
        </div>
      </div>
    );
  };

  const DailyLogPage = () => {
    if (!isChallengeActive) {
         return (
            <div className="p-6">
                <div className="bg-red-700 p-6 rounded-xl text-center shadow-lg">
                    <h2 className="text-3xl text-white font-bold">Challenge is not currently active.</h2>
                    <p className="text-white mt-2">The 30-Day Challenge runs from Day 1 to Day 30 only.</p>
                </div>
            </div>
        );
    }
    
    if (hasLoggedToday) {
        return (
            <div className="p-6">
                <div className="bg-green-700 p-6 rounded-xl text-center shadow-lg">
                    <h2 className="text-3xl text-white font-bold">You have already submitted Day {challengeDay}!</h2>
                    <p className="text-white mt-2">Review your growth in the **Growth Log**.</p>
                    <button onClick={() => setCurrentPage('history')} className="mt-4 px-4 py-2 bg-white text-green-700 rounded-lg font-semibold">Go to Growth Log</button>
                </div>
            </div>
        )
    }

    return (
      <div className="p-6">
        <h2 className="text-3xl font-bold text-white mb-6">Daily Forge: Day {challengeDay}</h2>
        <p className="text-gray-400 mb-6">Forge your identity by logging your actions for each of the five archetypes today. No excuses, only results.</p>

        <div className="space-y-6">
          {ARCHETYPES.map(({ key, title, prompt }) => (
            <div key={key} className="bg-gray-800 p-4 rounded-lg border-l-4 border-yellow-600 shadow-md">
              <label className="block text-xl font-semibold text-yellow-400 mb-2">{title}</label>
              <p className="text-gray-400 text-sm mb-2">{prompt}</p>
              <textarea
                value={dailyLog[key] || ''}
                onChange={(e) => handleInputChange(key, e.target.value)}
                rows="3"
                className="w-full p-3 bg-gray-900 text-white rounded-md border border-gray-700 focus:ring-yellow-500 focus:border-yellow-500"
                placeholder={`Describe your actions today for the ${title} archetype...`}
              ></textarea>
            </div>
          ))}
        </div>
        
        <GeminiStatus />

        <div className="mt-8">
            <button
                onClick={handleSynthesis}
                disabled={geminiLoading}
                className={`w-full py-3 rounded-lg text-lg font-bold transition duration-300 flex items-center justify-center space-x-2 
                    ${geminiLoading ? 'bg-yellow-900 text-yellow-400 cursor-wait' : 'bg-yellow-600 text-gray-900 hover:bg-yellow-500 shadow-xl'}`
                }
            >
                {geminiLoading ? 'Synthesizing...' : (
                    <>
                        <span>✨ Get Challenge Headline</span>
                    </>
                )}
            </button>
            
            {synthesisResult && (
                <div className="mt-4 p-4 bg-gray-800 rounded-lg border-l-4 border-yellow-400 text-gray-200 whitespace-pre-wrap">
                    <h4 className="text-yellow-400 font-bold mb-2">AI Synthesis:</h4>
                    {synthesisResult}
                </div>
            )}
        </div>

        <button
          onClick={handleLogSubmit}
          className="mt-6 w-full py-4 bg-red-700 text-white text-xl font-bold rounded-lg hover:bg-red-800 transition duration-300 shadow-xl"
        >
          SUBMIT DAY {challengeDay} LOG
        </button>
      </div>
    );
  };

  const HistoryPage = () => {
    return (
      <div className="p-6">
        <h2 className="text-3xl font-bold text-white mb-6">Growth Log: All Entries</h2>
        <p className="text-gray-400 mb-6">Review your commitment over the last 30 days. Iron doesn't sharpen alone—this proves you faced the friction.</p>

        <div className="bg-gray-800 p-5 rounded-xl mb-6 shadow-xl border-l-4 border-red-700">
            <h3 className="text-xl font-bold text-red-400 mb-3 flex items-center">
                ✨ AI Growth Analysis
            </h3>
            <div className="flex flex-col sm:flex-row gap-3 mb-4 items-center">
                <label className="text-gray-300 font-semibold flex-shrink-0">Analyze Archetype:</label>
                <select
                    value={selectedArchetypeForAnalysis}
                    onChange={(e) => {setSelectedArchetypeForAnalysis(e.target.value); setAnalysisResult(null);}}
                    className="w-full sm:w-auto p-2 bg-gray-900 text-white rounded-md border border-gray-700"
                >
                    {ARCHETYPES.map(a => (
                        <option key={a.key} value={a.key}>{a.title}</option>
                    ))}
                </select>
            </div>

            <GeminiStatus />
            
            <button
                onClick={handleGrowthAnalysis}
                disabled={geminiLoading || logs.length === 0}
                className={`w-full py-3 rounded-lg text-lg font-bold transition duration-300 flex items-center justify-center space-x-2 
                    ${geminiLoading || logs.length === 0
                        ? 'bg-red-900 text-red-400 cursor-wait' 
                        : 'bg-red-700 text-white hover:bg-red-600 shadow-md'}`
                }
            >
                {geminiLoading ? 'Analyzing History...' : `Analyze Past ${ARCHETYPES.find(a => a.key === selectedArchetypeForAnalysis).title} Entries`}
            </button>
            
            {analysisResult && (
                <div className="mt-4 p-4 bg-gray-900 rounded-lg border-l-4 border-red-400 text-gray-200 whitespace-pre-wrap">
                    <h4 className="text-red-400 font-bold mb-2">AI Coach Assessment:</h4>
                    {analysisResult}
                </div>
            )}
        </div>


        {logs.length === 0 ? (
          <div className="text-center p-8 bg-gray-800 rounded-lg text-gray-400">
            <p className="text-xl">No logs submitted yet. Start forging your first entry!</p>
          </div>
        ) : (
          <div className="space-y-4">
            {logs.map((log) => (
              <div key={log.id} className="bg-gray-800 p-4 rounded-lg shadow-lg border-l-4 border-yellow-600">
                <div className="flex justify-between items-center mb-2 border-b border-gray-700 pb-2">
                  <h3 className="text-xl font-bold text-yellow-400">DAY {log.day}</h3>
                  <p className="text-sm text-gray-400">{log.date}</p>
                </div>
                <dl className="space-y-2 text-gray-300">
                  {ARCHETYPES.map(({ key, title }) => (
                    <React.Fragment key={`${log.id}-${key}`}>
                      <dt className="font-semibold text-white mt-1">{title}:</dt>
                      <dd className="text-sm ml-2 pl-2 border-l border-gray-600 italic">
                        {log.entries[key] || <span className="text-gray-500">No entry recorded.</span>}
                      </dd>
                    </React.Fragment>
                  ))}
                </dl>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  if (loading) {
    return <LoadingScreen />;
  }

  const PageContent = () => {
    switch (currentPage) {
      case 'log':
        return <DailyLogPage />;
      case 'history':
        return <HistoryPage />;
      case 'home':
      default:
        return <HomePage />;
    }
  };

  return (
    <div className="min-h-screen bg-gray-950 font-sans">
        <style>{`
            @import url('https://fonts.googleapis.com/css2?family=Cinzel+Decorative:wght@700&display=swap');
            .font-serif {
                font-family: 'Cinzel Decorative', serif;
            }
        `}</style>
      <Header />
      <main className="max-w-4xl mx-auto pb-12">
        {error && (
          <div className="bg-red-800 text-white p-4 text-center font-bold">
            ERROR: {error}
          </div>
        )}
        <AppMessage />
        <PageContent />
      </main>
    </div>
  );
};

export default App;
