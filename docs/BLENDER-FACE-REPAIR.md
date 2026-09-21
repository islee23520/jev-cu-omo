# Zcode-reviewed Blender face and neck repair

This repository includes a source-specific, topology-preserving repair for the
connected `Female_Base_Assembly` mesh used by the Seoul Kenshi character
assembly proof of concept.

## Run

Requirements:

- Blender 5.1.x available as `blender`, or set `BLENDER_BIN`.
- The input file must contain the canonical `Female_Base_Assembly` mesh and
  match SHA-256
  `ad60f8affdef8fb67659214a25b887bc3795c86c207279d224b3ca5da3d0976d`.

```bash
npm run blender-face-repair -- /absolute/path/female-base-symmetric.blend /absolute/output-directory
```

Outputs:

```text
<output>/Female_FaceNeck_Repaired.blend
<output>/implementation-log.json
<output>/evidence/final/front.png
<output>/evidence/final/side.png
<output>/evidence/final/rear.png
<output>/evidence/final/threequarter.png
<output>/evidence/final/neck_close.png
```

The worker refuses an input with the wrong fingerprint and saves the final
Blend only after its structural assertions pass.

## Structural contract

- One connected indexed mesh; no cut, bridge, weld, remesh, subdivision, or
  decimation.
- Mesh counts remain `45,777 / 94,159 / 48,382` vertices/edges/faces.
- `26,440` torso vertices are locked byte-for-byte.
- Locked-coordinate digest:
  `aa6d5625b9279046d30c1e8b3a309b56646207cff1ee655530716d52de22d1af`.
- Topology digest:
  `8c1e401fb351df0b7fef3def31383d5d88ce67600045fcd0f4fa61dc9c03792d`.
- Existing boundary/nonmanifold counts remain `126 / 126` with no wire edges.
- Final rigid head/face set: `18,493` vertices, uniform scale `0.162`.
- Final measured body proportion: `7.127175159510203` head heights.

## Vision evidence

The RED and GREEN reviews used the local `zai-vision` MCP server's
`analyze_image` tool with ZAI `glm-5.3-flash`.

- RED: the canonical baseline was rejected for its oversized/floating head,
  missing neck-base anatomy, and absent SCM/trapezius/clavicle transition.
- GREEN: the final five-view contact sheet passed proportion, facial identity,
  head scale, neck length, gap/pin, and jaw-to-shoulder transition checks.

The final visual approval is still the human operator's responsibility. Zcode
was used as an external review oracle; Gemini was unavailable. **Astra was not
used.**

The local audit artifacts used during development are documented in
`QA.md`. They are intentionally not packaged because they contain absolute
workstation paths and large rendered images.
