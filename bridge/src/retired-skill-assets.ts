// SHA-256 inventory of bridge-owned assets shipped before retirement.
// Used only to recognize untouched installed copies; no execution content.
export const RETIRED_FACTORY_ASSETS: Readonly<Record<string, string>> = {
  "SKILL.md": "9c6b36583ef4534a2cbb81d9ae8813d411d3ccc14f3878fcf442ed873fc41d56",
  "factory-template": "directory",
  "factory-template/bin": "directory",
  "factory-template/bin/dispatch.py": "60f7f33015835eb276a88a0e0d2e0ec17aa8153ef46f718f95f32a226c918870",
  "factory-template/factory.yaml": "e4672704e9abff049595f81a65f07dcee462c64c8aa74c27e44966e6d450c9b2",
  "factory-template/skills": "directory",
  "factory-template/skills/_protocol.md": "ab11e25b7f071185e6b5839a9c72e87f277d8e9a60a5e59e7e76f34adc94af38",
  "factory-template/skills/design.md": "9be1746fb65c6b8fa2528620ed243c014990c840c023852c69fdc118c5e06059",
  "factory-template/skills/digest.md": "642acb7283a9b994910cab75632e447cdc1b5ca9466e37ad6e5be34a315da0e7",
  "factory-template/skills/groom.md": "4661818f3e110b86043f11b140d76c9e8165dd89019d2e6ec9059b3108863da6",
  "factory-template/skills/implement.md": "16e392533d8db59f7961eff63b389579198384523317976f3a45aa6a3352f1f3",
  "factory-template/skills/pr.md": "1b9b0728159a1d48c0761b6663e5685fb15fe3faedf8608a0faaeb6cfc8b54d6",
  "factory-template/skills/qa.md": "70902d361441ce38c8b3615ca757a79d272f37c09a1850a3aca8d0a495ca5358",
  "factory-template/skills/review.md": "3ede6058f024da2c080fd49d42b94e9b09fec6cac285235ec83631477e3d1c2a",
  "factory-template/skills/triage.md": "5fce18ea3417b3a37ec3e0ce4eaf4c004829133b3e879340c1e3f8b445d32d82"
};
export const RETIRED_LOOP_REFERENCE_SHA256 = "0b1d4b879321aaf9125d9203ab289a9e17057a3345c3afa6d97f7298bc8ed441";

export const RETIRED_FTICKET_ASSETS: Readonly<Record<string, string>> = {
  "SKILL.md": "d84e731b25ee7ee27b482cdfa49bb156719c4f7d17a291005c11dedfa0a42ebe"
};
export const RETIRED_WORKFLOW_SKILL_ASSETS: Readonly<Record<string, string>> = {
  "references/workflows.md": "dfc292df0c8cf6503b0a570c86d36e9f018c997bf0141aadba0a42537600dff7",
  "scripts/example.flow.mjs": "eb9ece0af09bafc0838a5e8174a15d98eddaa4d2ae69015175f890af08d0fc3c"
};
export const RETIRED_WORKFLOW_RUNTIME_ASSETS: Readonly<Record<string, string>> = {
  "ftown-workflows-cli.js": "c6a7d1b3565ce5ab2bafc95dbb6cc55e75ab295f1eed2628cc219b6724891623",
  "workflow-runner.js": "65d5e0e123362d5b1d98fccb7977001c391a14a0c0ab0352104c9e5de847eb0d"
};
