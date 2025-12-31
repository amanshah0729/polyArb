import { execSync } from 'child_process';
import path from 'path';
import { NextResponse } from 'next/server';

export async function POST() {
  const targetCwd = path.join('c:', 'Users', '21rah', 'OneDrive', 'Documents', 'polyArb');
  console.log('Target cwd:', targetCwd);
  try {
    execSync('node findAllArbitrage.js', { cwd: targetCwd });
    return NextResponse.json({ message: 'Arbitrage run successfully' });
  } catch (error) {
    console.error('Error details:', error);
    return NextResponse.json({ error: `Failed to run arbitrage: ${error.message}` }, { status: 500 });
  }
}