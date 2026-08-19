import { AlertTriangle } from "lucide-react";
import { useEffect, useState } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

export function ConfirmActionDialog({
  open,
  title,
  description,
  confirmLabel,
  destructive = false,
  disabled = false,
  confirmationText,
  confirmationLabel = "确认文本",
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  destructive?: boolean;
  disabled?: boolean;
  confirmationText?: string;
  confirmationLabel?: string;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const [typedConfirmation, setTypedConfirmation] = useState("");
  useEffect(() => { if (!open) setTypedConfirmation(""); }, [open]);
  const confirmationMissing = Boolean(confirmationText && typedConfirmation !== confirmationText);

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="psc-confirm-dialog" size="sm">
        <AlertDialogHeader>
          {destructive && <AlertDialogMedia><AlertTriangle aria-hidden="true" /></AlertDialogMedia>}
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {confirmationText && <div className="psc-confirm-field">
          <Label htmlFor="psc-confirm-input">{confirmationLabel}：请输入 <strong>{confirmationText}</strong></Label>
          <Input id="psc-confirm-input" value={typedConfirmation} onChange={(event) => setTypedConfirmation(event.target.value)} autoComplete="off" />
        </div>}
        <AlertDialogFooter>
          <AlertDialogCancel>取消</AlertDialogCancel>
          <AlertDialogAction
            disabled={disabled || confirmationMissing}
            variant={destructive ? "destructive" : "default"}
            onClick={() => {
              onOpenChange(false);
              onConfirm();
            }}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
