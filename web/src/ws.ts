import { useStore } from './store.ts';

let started = false;

export function startWebSocket() {
  if (started) return;
  started = true;
  let retry = 500;

  const connect = () => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);

    ws.onopen = () => {
      retry = 500;
      useStore.getState().setConnected(true);
    };
    ws.onmessage = (ev) => {
      try {
        useStore.getState().applyServerMsg(JSON.parse(ev.data));
      } catch (e) {
        console.error('bad ws message', e);
      }
    };
    ws.onclose = () => {
      useStore.getState().setConnected(false);
      setTimeout(connect, retry);
      retry = Math.min(retry * 2, 10000);
    };
    ws.onerror = () => ws.close();
  };

  connect();
}
