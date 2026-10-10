import { CheckCircle2, Megaphone, MessageSquareText, Send } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";

import type { AuthStatus } from "../api/contracts";
import { requestJson } from "../api/client";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { Field, FieldGroup, FieldLabel } from "./ui/field";
import { Spinner } from "./ui/spinner";
import { Textarea } from "./ui/textarea";

const BROADCAST_PRESETS = [
  "欢迎各位训练家加入帕鲁之岛！请爱护帕鲁，文明游戏。",
  "海岛守护者通知：服务器将在 10 分钟后进行存档热维护。",
  "全服双倍掉落活动开启：今日抓捕与击败 Boss 奖励翻倍！",
  "请大家规范建造据点，避免在公共传送点和矿点堵路。",
];

export function BroadcastDialog({ auth, open, onOpenChange }: { auth: AuthStatus; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  useEffect(() => {
    if (open) { setError(""); setSuccess(""); }
  }, [open]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const content = message.trim();
    if (!content) return;
    setBusy(true); setError(""); setSuccess("");
    try {
      const result = await requestJson<{ message: string }>("/api/live/announce", {
        method: "POST",
        headers: { "X-CSRF-Token": auth.csrfToken || "" },
        body: JSON.stringify({ message: content }),
      });
      setMessage("");
      setSuccess(result.message);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "全服广播发送失败");
    } finally {
      setBusy(false);
    }
  }

  return <Dialog open={open} onOpenChange={(nextOpen) => { if (!busy) onOpenChange(nextOpen); }}>
    <DialogContent className="psc-broadcast-dialog">
      <DialogHeader className="psc-broadcast-header">
        <span className="psc-broadcast-icon" aria-hidden="true"><Megaphone /></span>
        <div><DialogTitle>全服广播系统</DialogTitle><DialogDescription>实时推送通知至所有在线训练家屏幕</DialogDescription></div>
      </DialogHeader>
      <form className="psc-broadcast-form" onSubmit={(event) => void submit(event)}>
        {error && <Alert variant="destructive"><AlertTitle>广播未发送</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}
        {success && <Alert variant="success" role="status"><CheckCircle2 aria-hidden="true" /><AlertTitle>广播已发送</AlertTitle><AlertDescription>{success}</AlertDescription></Alert>}
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="psc-broadcast-message">广播内容正文</FieldLabel>
            <Textarea id="psc-broadcast-message" rows={4} maxLength={500} required disabled={busy} value={message} onChange={(event) => { setMessage(event.target.value); setSuccess(""); }} placeholder="请输入要在游戏顶部滚动的广播通知……" />
            <div className="psc-broadcast-counter"><span>支持中英文与特殊字符</span><span>{message.length} / 500</span></div>
          </Field>
          <Field>
            <FieldLabel>快捷预设模板</FieldLabel>
            <div className="psc-broadcast-presets">{BROADCAST_PRESETS.map((preset) => <Button key={preset} variant="outline" type="button" disabled={busy} onClick={() => { setMessage(preset); setSuccess(""); }}><MessageSquareText data-icon="inline-start" aria-hidden="true" /><span>{preset}</span></Button>)}</div>
          </Field>
        </FieldGroup>
        <DialogFooter className="psc-broadcast-footer">
          <Button variant="ghost" type="button" disabled={busy} onClick={() => onOpenChange(false)}>取消</Button>
          <Button type="submit" disabled={busy || !message.trim()}>{busy ? <Spinner data-icon="inline-start" /> : <Send data-icon="inline-start" aria-hidden="true" />}立即发送广播</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
