import { useEffect, useState, type ReactNode } from 'react';

/** Avoid flashing a placeholder for reads that finish within a frame or two. */
export function Delayed({ children }: { children: ReactNode }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), 200);
    return () => clearTimeout(timer);
  }, []);
  return visible ? children : null;
}
