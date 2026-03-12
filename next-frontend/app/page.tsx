'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import Image from 'next/image';

export default function Home() {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const handlePasswordSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // TODO: Replace with actual password check (environment variable or API)
    const correctPassword = 'polyarb';
    
    if (password === correctPassword) {
      // Store authentication in sessionStorage
      sessionStorage.setItem('authenticated', 'true');
      // Redirect to results page immediately after authentication
      router.push('/results');
    } else {
      setError('');
      setPassword('');
      // Don't show error message to keep it mysterious
    }
  };

  // Show password screen - redirects to /results on correct password
  return (
    <div className="min-h-screen flex items-center justify-center flex-col" style={{ backgroundColor: 'rgb(9, 9, 11)' }}>
      <div className="mb-8">
        <Image
          src="/polyarblogo.png"
          alt="Logo"
          width={200}
          height={200}
          className="object-contain"
        />
      </div>
      <form onSubmit={handlePasswordSubmit} className="w-full max-w-sm">
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full bg-transparent border border-white text-white px-4 py-3 rounded-lg focus:outline-none focus:border-white"
          autoFocus
        />
      </form>
    </div>
  );
}
