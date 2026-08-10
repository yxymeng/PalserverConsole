import { useEffect, useRef, useState } from "react";

export type LiveConnectionStatus = "connecting" | "open" | "reconnecting" | "closed";

export function liveConnectionLabel(status: LiveConnectionStatus): string {
  return {
    connecting: "正在连接实时事件",
    open: "实时事件已连接",
    reconnecting: "实时事件正在重连",
    closed: "实时事件已关闭",
  }[status];
}

export function useLiveEvents<T>(
  url: string,
  eventName: string,
  onMessage: (payload: T) => void,
  onMalformedMessage: () => void,
) {
  const [status, setStatus] = useState<LiveConnectionStatus>("connecting");
  const onMessageRef = useRef(onMessage);
  const onMalformedMessageRef = useRef(onMalformedMessage);

  useEffect(() => { onMessageRef.current = onMessage; }, [onMessage]);
  useEffect(() => { onMalformedMessageRef.current = onMalformedMessage; }, [onMalformedMessage]);

  useEffect(() => {
    const events = new EventSource(url, { withCredentials: true });
    setStatus("connecting");
    events.onopen = () => setStatus("open");
    events.onerror = () => setStatus(events.readyState === EventSource.CLOSED ? "closed" : "reconnecting");
    const listener = (event: Event) => {
      try {
        onMessageRef.current(JSON.parse((event as MessageEvent<string>).data) as T);
      } catch {
        onMalformedMessageRef.current();
      }
    };
    events.addEventListener(eventName, listener);
    return () => {
      events.removeEventListener(eventName, listener);
      events.close();
    };
  }, [eventName, url]);

  return status;
}
