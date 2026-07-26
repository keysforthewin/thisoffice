import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import { startWebSocket } from './ws.ts';
import { armBootScreenTimeout } from './boot.ts';

// a failed GLB / WebGL context must not leave the spinner up forever
armBootScreenTimeout();
startWebSocket();
createRoot(document.getElementById('root')!).render(<App />);
