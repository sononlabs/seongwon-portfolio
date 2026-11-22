const FROM = 'Inter';
const TO = 'Pretendard Variable';

async function run() {
  const fonts = await figma.listAvailableFontsAsync();
  const toStyles = new Set(fonts.filter(f => f.fontName.family === TO).map(f => f.fontName.style));
  if (toStyles.size === 0) return `${TO} 폰트가 이 PC에 없습니다`;

  // 피그마의 스타일 이름 표기 차이("Semi Bold" vs "SemiBold")를 흡수
  const mapStyle = (style) => {
    if (toStyles.has(style)) return style;
    const compact = style.replace(/\s+/g, '');
    for (const s of toStyles) if (s.replace(/\s+/g, '') === compact) return s;
    return null;
  };

  const missing = new Set();
  const target = async (fontName) => {
    const style = mapStyle(fontName.style);
    if (!style) { missing.add(fontName.style); return null; }
    const f = { family: TO, style };
    await figma.loadFontAsync(f);
    return f;
  };

  let styleCount = 0;
  for (const s of await figma.getLocalTextStylesAsync()) {
    if (s.fontName.family !== FROM) continue;
    const f = await target(s.fontName);
    if (!f) continue;
    await figma.loadFontAsync(s.fontName);
    s.fontName = f;
    s.description = s.description.split('\n').filter(l => !l.includes(FROM)).join('\n').trim();
    styleCount++;
  }

  await figma.loadAllPagesAsync();
  const insideInstance = (n) => { for (let p = n.parent; p; p = p.parent) if (p.type === 'INSTANCE') return true; return false; };
  const texts = figma.root.findAllWithCriteria({ types: ['TEXT'] });
  // 원본 컴포넌트를 먼저 바꿔야 인스턴스가 그대로 따라오고 불필요한 오버라이드가 안 생김
  const ordered = [...texts.filter(t => !insideInstance(t)), ...texts.filter(insideInstance)];

  let nodeCount = 0;
  for (const t of ordered) {
    const segs = t.getStyledTextSegments(['fontName', 'textStyleId']);
    const loose = segs.filter(sg => sg.fontName.family === FROM && !sg.textStyleId);
    if (!loose.length) continue;
    for (const sg of segs) await figma.loadFontAsync(sg.fontName);
    for (const sg of loose) {
      const f = await target(sg.fontName);
      if (f) t.setRangeFontName(sg.start, sg.end, f);
    }
    nodeCount++;
  }

  const warn = missing.size ? ` / 대응 굵기 없음: ${[...missing].join(', ')}` : '';
  return `텍스트 스타일 ${styleCount}개, 개별 텍스트 ${nodeCount}개를 ${TO}로 교체${warn}`;
}

run().then(msg => figma.closePlugin(msg)).catch(e => figma.closePlugin(`오류: ${e.message}`));
