import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import { startWebSocket } from './ws.ts';

startWebSocket();
createRoot(document.getElementById('root')!).render(<App />);
