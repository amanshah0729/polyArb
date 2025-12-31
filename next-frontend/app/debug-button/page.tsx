'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

export default function DebugButton() {
  const router = useRouter();
  const [logs, setLogs] = useState<string[]>([]);

  const addLog = (message: string) => {
    const timestamp = new Date().toLocaleTimeString();
    setLogs(prev => [...prev, `[${timestamp}] ${message}`]);
  };

  const clearLogs = () => {
    setLogs([]);
  };

  const testBasicClick = () => {
    addLog('✅ Basic click event works!');
  };

  const testRouter = () => {
    addLog('Testing router.push("/results")...');
    try {
      router.push('/results');
      addLog('✅ Router navigation triggered');
    } catch (error: any) {
      addLog(`❌ Router error: ${error.message}`);
    }
  };

  const testAPI = async () => {
    addLog('Testing API call to /api/run-arbitrage...');
    try {
      const response = await fetch('/api/run-arbitrage', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        }
      });
      const data = await response.json();
      if (response.ok) {
        addLog(`✅ API Success: ${data.message}`);
      } else {
        addLog(`❌ API Error: ${data.error}`);
      }
    } catch (error: any) {
      addLog(`❌ Network Error: ${error.message}`);
    }
  };

  const testFullFlow = async () => {
    clearLogs();
    addLog('=== Starting Full Flow Test ===');
    addLog('Step 1: Button clicked ✅');
    
    addLog('Step 2: Calling API...');
    try {
      const response = await fetch('/api/run-arbitrage', {
        method: 'POST'
      });
      const data = await response.json();
      if (response.ok) {
        addLog(`Step 2: API Success - ${data.message} ✅`);
        addLog('Step 3: Navigating to /results...');
        setTimeout(() => {
          router.push('/results');
          addLog('Step 3: Navigation triggered ✅');
          addLog('=== Full Flow Complete ===');
        }, 100);
      } else {
        addLog(`Step 2: API Error - ${data.error} ❌`);
      }
    } catch (error: any) {
      addLog(`Step 2: Network Error - ${error.message} ❌`);
    }
  };

  return (
    <div className="min-h-screen bg-gray-900 text-white p-8">
      <div className="max-w-4xl mx-auto">
        <h1 className="text-3xl font-bold mb-6">Button Debugging Tool</h1>
        
        <div className="bg-gray-800 rounded-lg p-6 mb-6">
          <h2 className="text-xl font-semibold mb-4">Test Buttons</h2>
          <div className="flex flex-wrap gap-4 mb-4">
            <button
              onClick={testBasicClick}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded"
            >
              Test 1: Basic Click
            </button>
            <button
              onClick={testRouter}
              className="px-4 py-2 bg-green-600 hover:bg-green-700 rounded"
            >
              Test 2: Router Navigation
            </button>
            <button
              onClick={testAPI}
              className="px-4 py-2 bg-purple-600 hover:bg-purple-700 rounded"
            >
              Test 3: API Call
            </button>
            <button
              onClick={testFullFlow}
              className="px-4 py-2 bg-pink-600 hover:bg-pink-700 rounded"
            >
              Test 4: Full Flow
            </button>
            <button
              onClick={clearLogs}
              className="px-4 py-2 bg-gray-600 hover:bg-gray-700 rounded"
            >
              Clear Logs
            </button>
          </div>
        </div>

        <div className="bg-black rounded-lg p-4">
          <h2 className="text-xl font-semibold mb-4">Debug Logs</h2>
          <div className="font-mono text-sm space-y-1 max-h-96 overflow-y-auto">
            {logs.length === 0 ? (
              <div className="text-gray-500">No logs yet. Click a test button above.</div>
            ) : (
              logs.map((log, index) => (
                <div key={index} className={log.includes('❌') ? 'text-red-400' : log.includes('✅') ? 'text-green-400' : 'text-gray-300'}>
                  {log}
                </div>
              ))
            )}
          </div>
        </div>

        <div className="mt-6 bg-gray-800 rounded-lg p-6">
          <h2 className="text-xl font-semibold mb-4">Current Home Page Button Code</h2>
          <pre className="bg-black p-4 rounded text-sm overflow-x-auto">
{`const handleClick = () => {
  console.log('Button clicked!');
  router.push('/results');
};`}
          </pre>
          <p className="mt-4 text-gray-400">
            If the button still doesn't work, check:
          </p>
          <ul className="list-disc list-inside mt-2 text-gray-400 space-y-1">
            <li>Browser console for errors (F12)</li>
            <li>Network tab to see if API calls are being made</li>
            <li>That the Next.js dev server is running</li>
            <li>That the /results page exists</li>
          </ul>
        </div>
      </div>
    </div>
  );
}

