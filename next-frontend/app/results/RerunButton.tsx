'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface RerunButtonProps {
  apiRoute?: string;
  label?: string;
  loadingLabel?: string;
}

export default function RerunButton({
  apiRoute = '/api/run-arbitrage',
  label = 'Recalculate Arb',
  loadingLabel = 'Running...',
}: RerunButtonProps) {
  const [isLoading, setIsLoading] = useState(false);
  const router = useRouter();

  const handleRerun = async () => {
    setIsLoading(true);
    try {
      const response = await fetch(apiRoute, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      const data = await response.json();

      if (response.ok && data.message) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        router.refresh();
      } else {
        alert(data.error || 'Failed to run arbitrage script');
      }
    } catch (error: any) {
      alert('Error: ' + error.message);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <button
      onClick={handleRerun}
      disabled={isLoading}
      className={`px-6 py-2 text-white font-semibold rounded-lg transition-all ${
        isLoading
          ? 'bg-gray-800 cursor-not-allowed opacity-50'
          : 'bg-black hover:bg-gray-900 active:bg-gray-800'
      }`}
    >
      {isLoading ? loadingLabel : label}
    </button>
  );
}
