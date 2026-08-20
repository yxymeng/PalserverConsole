import { AlertTriangle, CheckCircle2, CircleStop } from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useState } from "react";

import type { Operation } from "../api/contracts";
import { Button } from "./ui/button";
import { Spinner } from "./ui/spinner";

const TERMINAL_STATES = new Set(["succeeded", "failed", "cancelled"]);
const STAGE_PROGRESS: Record<string, number> = {
  queued: 8,
  countdown: 18,
  saving: 38,
  stopping: 66,
  force_stopping: 72,
  restarting: 78,
  health_check: 90,
};

export function OperationStatusIsland({
  operation,
  onCancel,
  onForceStop,
  countdownSeconds = 30,
}: {
  operation: Operation;
  onCancel: () => void;
  onForceStop: () => void;
  countdownSeconds?: number;
}) {
  const [stageStartedAt, setStageStartedAt] = useState(Date.now());
  const [now, setNow] = useState(Date.now());
  const countdown = operation.stage === "countdown" && ["queued", "running"].includes(operation.state);
  const needsForceConfirmation = operation.state === "awaiting_force_confirmation";
  const completed = TERMINAL_STATES.has(operation.state);

  useEffect(() => {
    const timestamp = Date.now();
    setStageStartedAt(timestamp);
    setNow(timestamp);
  }, [operation.operationId, operation.stage]);

  useEffect(() => {
    if (!countdown) return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [countdown]);

  const startedAt = operation.updatedAt ? operation.updatedAt * 1_000 : stageStartedAt;
  const elapsedSeconds = Math.max(0, (now - startedAt) / 1_000);
  const remainingSeconds = Math.max(0, Math.ceil(countdownSeconds - elapsedSeconds));
  const progress = operation.state === "succeeded" ? 100
    : operation.state === "cancelled" || operation.state === "failed" ? 100
      : countdown ? Math.min(100, (elapsedSeconds / countdownSeconds) * 100)
        : STAGE_PROGRESS[operation.stage] ?? 12;
  const tone = operation.state === "failed" || needsForceConfirmation ? "danger"
    : operation.state === "succeeded" ? "success"
      : operation.state === "cancelled" ? "neutral" : "active";

  return <section className="operation-island" data-tone={tone} aria-label="当前操作状态" aria-live="polite">
    <div className="operation-island-main">
      <span className="operation-island-icon" aria-hidden="true">{operationIcon(operation)}</span>
      <div className="operation-island-copy"><span>当前操作</span><strong>{operationKindLabel(operation.kind)}</strong><small>{operationDescription(operation)}</small></div>
      <div className="operation-island-actions">
        {countdown && <Button variant="outline" type="button" onClick={onCancel}>取消</Button>}
        {needsForceConfirmation && <Button variant="destructive" type="button" onClick={onForceStop}><CircleStop data-icon="inline-start" aria-hidden="true" />确认强制停止</Button>}
      </div>
    </div>
    <div className="operation-island-progress">
      <div><span>{countdown ? "维护倒计时" : completed ? "执行结果" : "阶段进度"}</span><strong>{countdown ? `剩余 ${remainingSeconds} 秒` : operationStageLabel(operation)}</strong></div>
      <div className="operation-liquid-progress" role="progressbar" aria-label={countdown ? "维护倒计时进度" : "服务器操作进度"} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress)}>
        <motion.div className="operation-liquid-fill" initial={false} animate={{ width: `${progress}%` }} transition={{ type: "spring", stiffness: 80, damping: 22, mass: 0.7 }}>
          <span className="operation-liquid-surface" aria-hidden="true" />
        </motion.div>
      </div>
    </div>
  </section>;
}

function operationIcon(operation: Operation) {
  if (operation.state === "succeeded") return <CheckCircle2 />;
  if (operation.state === "failed" || operation.state === "awaiting_force_confirmation") return <AlertTriangle />;
  if (operation.state === "cancelled") return <CircleStop />;
  return <Spinner />;
}

function operationKindLabel(kind: string) {
  return ({ start: "启动服务器", save: "保存世界", stop: "关闭服务器", restart: "重启服务器", force_stop: "强制停止服务器" } as Record<string, string>)[kind] || "服务器操作";
}

function operationDescription(operation: Operation) {
  if (operation.state === "succeeded") return ({ start: "服务器已启动。", save: "世界数据已保存。", stop: "服务器已完全关闭。", restart: "服务器已重启。", force_stop: "服务器已强制停止。" } as Record<string, string>)[operation.kind] || "操作已完成。";
  if (operation.state === "cancelled") return "操作已取消，服务器保持当前状态。";
  if (operation.state === "failed") return "操作未完成，请检查服务器状态或日志。";
  if (operation.state === "awaiting_force_confirmation") return "服务器尚未退出，确认后才会强制停止。";
  return ({ queued: "正在等待服务器执行。", countdown: "维护倒计时中，仍可取消。", saving: "正在保存世界数据。", stopping: "正在请求服务器关闭。", restarting: "正在重新启动服务器。", health_check: "正在检查服务器启动状态。", force_stopping: "正在强制停止服务器。" } as Record<string, string>)[operation.stage] || "正在执行，请稍候。";
}

function operationStageLabel(operation: Operation) {
  if (operation.state === "succeeded") return "已完成";
  if (operation.state === "failed") return "未完成";
  if (operation.state === "cancelled") return "已取消";
  if (operation.state === "awaiting_force_confirmation") return "等待确认";
  return ({ queued: "等待执行", saving: "保存世界", stopping: "安全关闭", restarting: "重新启动", health_check: "健康检查", force_stopping: "强制停止" } as Record<string, string>)[operation.stage] || "处理中";
}
