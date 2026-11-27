// Shader rules: the few patterns that cost whole passes or defeat early-z.
export function analyzeShaders(project) {
  const out = [];
  const screen = [];
  const discard = [];
  const loops = [];
  for (const f of project.ext(".gdshader")) {
    if (f.startsWith("addons/gameoptimizer/")) continue;
    const text = (project.text(f) ?? "").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    if (!/shader_type\s+spatial/.test(text)) continue;
    if (/hint_screen_texture|hint_depth_texture|SCREEN_TEXTURE|DEPTH_TEXTURE/.test(text)) screen.push({ file: f, reads: [/hint_screen_texture|SCREEN_TEXTURE/.test(text) && "screen", /hint_depth_texture|DEPTH_TEXTURE/.test(text) && "depth"].filter(Boolean).join("+") });
    if (/\bdiscard\b/.test(text) && !/render_mode[^;]*depth_prepass_alpha/.test(text)) discard.push({ file: f });
    const m = /for\s*\([^;]*;[^;]*<\s*(\d+)/.exec(text);
    if (m && Number(m[1]) >= 32 && /texture\(/.test(text)) loops.push({ file: f, iterations: Number(m[1]) });
  }
  if (screen.length >= 3) out.push({ id: "shader/screen-reads", severity: "low", category: "shaders", title: `${screen.length} spatial shaders read the screen or depth texture`, detail: "A material that reads the screen is drawn in the transparent pass after a copy of the frame: no early-z, no depth prepass, sorted back to front. Fine for water and glass; costly on anything that covers much of the screen or is used on many objects.", evidence: screen.slice(0, 8), fix: null, risk: "none" });
  if (discard.length >= 3) out.push({ id: "shader/discard", severity: "low", category: "shaders", title: `${discard.length} spatial shaders use discard`, detail: "discard turns off early depth rejection for that material. For foliage use alpha scissor with render_mode depth_prepass_alpha so the prepass still culls what is behind.", evidence: discard.slice(0, 8), fix: null, risk: "none" });
  if (loops.length) out.push({ id: "shader/long-texture-loops", severity: "medium", category: "shaders", title: `${loops.length} shaders sample textures in loops of 32 steps or more`, detail: "That many texture reads per pixel is the cost of the whole rest of the frame on a mid-range GPU. Lower the step count per quality tier (a uniform or a global shader parameter) and draw the effect at half resolution.", evidence: loops, fix: null, risk: "visual" });
  return out;
}
