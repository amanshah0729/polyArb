'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

export default function Home() {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);

  const handleClick = async () => {
    setIsLoading(true);
    try {
      const response = await fetch('/api/run-arbitrage', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        }
      });
      
      const data = await response.json();
      
      if (response.ok && data.message) {
        // Script ran successfully, wait a moment for files to be written, then navigate
        await new Promise(resolve => setTimeout(resolve, 1000));
        // Force a hard navigation to bypass cache
        window.location.href = '/results';
      } else {
        // Show error
        alert(data.error || 'Failed to run arbitrage script');
        setIsLoading(false);
      }
    } catch (error: any) {
      alert('Error: ' + error.message);
      setIsLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center flex-col">
      <h1 className="text-8xl font-bold text-sky-400 mb-8 font-dancing">BigBallsReactHere</h1>
      <button 
        onClick={handleClick} 
        disabled={isLoading}
        className={`px-6 py-3 text-white font-semibold rounded ${
          isLoading 
            ? 'bg-gray-500 cursor-not-allowed' 
            : 'bg-pink-400 hover:bg-pink-500'
        }`}
      >
        {isLoading ? 'Running arbitrage script...' : 'How much wood can a woodchuck chuck?'}
      </button>
    </div>
  );
}
