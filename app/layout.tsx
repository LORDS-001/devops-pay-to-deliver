import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'DevOps Pay-to-Deliver · Fiber Testnet',
  description: 'Get paid. Prove delivery. Pay-to-unlock DevOps deliverables over the Fiber Network on CKB Testnet.',
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
