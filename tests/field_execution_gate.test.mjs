import assert from "node:assert/strict";
import test from "node:test";
import {
  assertTaskContractExecutable,
  validateTaskContractExecution,
} from "../src/field_execution_gate.mjs";
import {
  instantiateFieldCapability,
  listFieldCapabilities,
} from "../src/pgy_field_library_v1.mjs";

test("已与蒲公英前端对齐的字段合同可以执行", () => {
  const capability = listFieldCapabilities({
    surfaceStatus: "pgy_ui_verified",
    outputKind: "scalar",
  }).find((item) => item.fieldId === "pgy.creator.fans");
  const contract = instantiateFieldCapability(capability, {});
  const task = {
    columns: [{
      key: "K:粉丝数",
      displayLabel: "粉丝数",
      contract,
    }],
  };
  assert.equal(validateTaskContractExecution(task).valid, true);
  assert.doesNotThrow(() => assertTaskContractExecutable(task));
});

test("仅观察到接口但未完成前端对齐的字段不能越过确认门", () => {
  const capability = listFieldCapabilities({
    surfaceStatus: "api_observed_needs_ui_alignment",
    outputKind: "scalar",
  })[0];
  assert.ok(capability);
  const contract = instantiateFieldCapability(capability, {});
  const task = {
    columns: [{
      key: "Z:未知字段",
      displayLabel: capability.platformLabel,
      contract,
    }],
  };
  const validation = validateTaskContractExecution(task);
  assert.equal(validation.valid, false);
  assert.match(validation.issues[0].errors.join("；"), /尚未与蒲公英前端名称和路径对齐/);
  assert.throws(() => assertTaskContractExecutable(task), /字段合同尚不可执行/);
});
