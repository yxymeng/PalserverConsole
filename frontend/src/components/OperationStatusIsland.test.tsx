import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";

import { OperationStatusIsland } from "./OperationStatusIsland";

test.each([
  ["running", "saving", "保存世界，按执行阶段估算", "38"],
  ["succeeded", "stopped", "已完成", "100"],
  ["failed", "stopping", "未完成", "100"],
  ["cancelled", "countdown", "已取消", "100"],
  ["awaiting_force_confirmation", "stopping", "等待确认", "66"],
])("FlowMist keeps operation meaning for %s", (state, stage, description, progress) => {
  const markup = renderToStaticMarkup(<OperationStatusIsland
    operation={{ operationId: "test", kind: "stop", state, stage, errorCode: null, detail: null }}
    onCancel={() => {}} onForceStop={() => {}} />);
  expect(markup).toContain('class="flowmist operation-flowmist"');
  expect(markup).toContain(`aria-valuetext="${description}"`);
  expect(markup).toContain(`aria-valuenow="${progress}"`);
  expect(markup.includes("确认强制停止")).toBe(state === "awaiting_force_confirmation");
});
