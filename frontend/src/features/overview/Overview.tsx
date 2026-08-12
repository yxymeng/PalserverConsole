import { AlertTriangle } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import type { AuthStatus, ShellStatus } from "../../api/contracts";
import { LiveMonitoring } from "../monitoring/LiveMonitoring";
import { OperationalHealthPanel } from "./OperationalHealthPanel";
import { ServerControlPanel } from "../server/ServerControlPanel";

export function Overview({ shell, auth }: { shell: ShellStatus | null; auth: AuthStatus }) {
  const [shellStatus, setShellStatus] = useState(shell);

  useEffect(() => setShellStatus(shell), [shell]);

  return (
    <div className="page-stack">
      {!auth.local && <div className="warning-strip"><AlertTriangle size={18} />仅可信内网使用，禁止公网暴露。</div>}
      <HomeHero>
        <ServerControlPanel auth={auth} initialStatus={shellStatus} onStatusChange={setShellStatus} />
      </HomeHero>
      <LiveMonitoring auth={auth} embedded shell={shellStatus} />
      <OperationalHealthPanel auth={auth} />
    </div>
  );
}

function HomeHero({ children }: { children: ReactNode }) {
  return <section className="home-hero home-control-hero" aria-label="首页服务器控制">
    <div className="home-hero-copy">
      <p className="home-hero-kicker">PalServer</p>
      <h2>服务器控制</h2>
      {children}
    </div>
    <div className="hero-character-stage" aria-hidden="true">
      <span className="hero-character-orbit orbit-one" /><span className="hero-character-orbit orbit-two" />
      <span className="hero-character-bolt bolt-one" /><span className="hero-character-bolt bolt-two" />
      <img className="hero-character" src="/hero-character-placeholder.svg" alt="" />
    </div>
  </section>;
}
