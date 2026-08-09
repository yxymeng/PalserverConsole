import { AppGate } from "./app/AppGate";
import { ErrorBoundary } from "./app/ErrorBoundary";

export default function App() {
  return <ErrorBoundary><AppGate /></ErrorBoundary>;
}
