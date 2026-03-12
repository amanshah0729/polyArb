'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

export default function ResultsClient({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [isAuthenticated, setIsAuthenticated] = useState(false);

  useEffect(() => {
    // Check if user is authenticated (stored in sessionStorage)
    const auth = sessionStorage.getItem('authenticated');
    if (auth === 'true') {
      setIsAuthenticated(true);
    } else {
      // Redirect to home page if not authenticated
      router.push('/');
    }
  }, [router]);

  if (!isAuthenticated) {
    return null; // Don't render anything while checking
  }

  return <>{children}</>;
}

