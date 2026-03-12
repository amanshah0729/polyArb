'use client';
import { useRouter, useSearchParams } from 'next/navigation';

const TABS = [
  { key: 'sportsbook', label: 'Sportsbook Arb' },
  { key: 'predmarket', label: 'Pred Market Arb' },
];

export default function TabBar() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const activeTab = searchParams.get('tab') ?? 'sportsbook';

  return (
    <div className="flex gap-1 px-8 pt-6 border-b border-[rgba(255,255,255,0.08)]">
      {TABS.map((tab) => {
        const isActive = activeTab === tab.key;
        return (
          <button
            key={tab.key}
            onClick={() => router.push(`/results?tab=${tab.key}`)}
            className={`px-5 py-2.5 text-sm font-semibold rounded-t-lg transition-all relative ${
              isActive
                ? 'text-white bg-[#111827] border border-b-[#111827] border-[rgba(255,255,255,0.12)] -mb-px z-10'
                : 'text-[#6b7280] hover:text-[#9ca3af] bg-transparent'
            }`}
          >
            {tab.label}
            {isActive && (
              <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-[#60a5fa] rounded-t" />
            )}
          </button>
        );
      })}
    </div>
  );
}
