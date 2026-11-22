figma.showUI(__html__, { width: 360, height: 480, themeColors: true });

async function snapshot() {
  const cols = await figma.variables.getLocalVariableCollectionsAsync();
  const modeOf = Object.fromEntries(cols.map((c) => [c.id, c.defaultModeId]));
  const out = [];
  for (const v of await figma.variables.getLocalVariablesAsync()) {
    const m = (v.codeSyntax.WEB || '').match(/var\((--[\w-]+)\)/);
    if (!m || (v.resolvedType !== 'COLOR' && v.resolvedType !== 'FLOAT')) continue;
    const value = v.valuesByMode[modeOf[v.variableCollectionId]];
    if (value && typeof value === 'object' && value.type === 'VARIABLE_ALIAS') continue;
    out.push({ id: v.id, css: m[1], type: v.resolvedType, value });
  }
  return out;
}

async function apply(items) {
  for (const { id, value } of items) {
    const v = await figma.variables.getVariableByIdAsync(id);
    const col = await figma.variables.getVariableCollectionByIdAsync(v.variableCollectionId);
    v.setValueForMode(col.defaultModeId, value);
  }
}

figma.ui.onmessage = async (msg) => {
  try {
    if (msg.type === 'snapshot') figma.ui.postMessage({ reqId: msg.reqId, vars: await snapshot() });
    else if (msg.type === 'apply') { await apply(msg.items); figma.ui.postMessage({ reqId: msg.reqId, ok: true }); }
  } catch (e) {
    figma.ui.postMessage({ reqId: msg.reqId, error: String((e && e.message) || e) });
  }
};
