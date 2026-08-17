import { AppGate } from "./app/AppGate";
import { ErrorBoundary } from "./app/ErrorBoundary";
import { TooltipProvider } from "./components/ui/tooltip";

export default function App() {
  return <TooltipProvider><ErrorBoundary><AppGate /></ErrorBoundary></TooltipProvider>;
}
