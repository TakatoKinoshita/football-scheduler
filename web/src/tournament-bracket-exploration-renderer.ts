import {
  isTournamentBracketExplorationModel,
  type TournamentBracketExplorationGeometry,
  type TournamentBracketExplorationPoint,
  type TournamentBracketExplorationSegment,
  type TournamentBracketExplorationSlot,
} from "./tournament-bracket-exploration-layouts";
import { TournamentBracketError, type TournamentBracketModel } from "./tournament-bracket";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

function svgElement<K extends keyof SVGElementTagNameMap>(
  name: K,
  attributes: Readonly<Record<string, string | number>> = {},
): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG_NAMESPACE, name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  return element;
}

function transformedPoint(
  point: TournamentBracketExplorationPoint,
  geometry: TournamentBracketExplorationGeometry,
): TournamentBracketExplorationPoint {
  return geometry.orientation === "vertical"
    ? point
    : { x: geometry.height - point.y, y: point.x };
}

function transformedSlot(
  slot: TournamentBracketExplorationSlot,
  geometry: TournamentBracketExplorationGeometry,
): TournamentBracketExplorationSlot {
  return { ...slot, center: transformedPoint(slot.center, geometry) };
}

function transformedSegment(
  segment: TournamentBracketExplorationSegment,
  geometry: TournamentBracketExplorationGeometry,
  slotByKey: ReadonlyMap<string, TournamentBracketExplorationSlot>,
): { start: TournamentBracketExplorationPoint; end: TournamentBracketExplorationPoint } {
  let start = transformedPoint(segment.start, geometry);
  const end = transformedPoint(segment.end, geometry);
  if (geometry.orientation === "horizontal" && segment.slotAttachment !== undefined) {
    const slot = slotByKey.get(segment.slotAttachment.slotKey);
    if (slot === undefined) throw new TournamentBracketError("回転後のチーム枠を読み取れませんでした。");
    start = {
      x: slot.center.x + (segment.slotAttachment.outcome === "winner" ? slot.width / 2 : -slot.width / 2),
      y: slot.center.y,
    };
  }
  return { start, end };
}

export function renderTournamentBracketExploration(
  model: TournamentBracketModel,
  heading: string,
): HTMLElement {
  if (!isTournamentBracketExplorationModel(model)) {
    throw new TournamentBracketError("探索用トーナメント表モデルを読み取れませんでした。");
  }
  const geometry = model.explorationGeometry;
  const width = geometry.orientation === "vertical" ? geometry.width : geometry.height;
  const height = geometry.orientation === "vertical" ? geometry.height : geometry.width;
  const slots = geometry.slots.map((slot) => transformedSlot(slot, geometry));
  const slotByKey = new Map(slots.map((slot) => [slot.key, slot]));
  const figure = document.createElement("figure");
  figure.className = `tournament-bracket exploration ${geometry.orientation}`;
  figure.dataset.pool = model.pool;
  figure.dataset.participantCount = String(model.participantCount);
  figure.dataset.layout = geometry.orientation;
  const svg = svgElement("svg", {
    viewBox: `0 0 ${String(width)} ${String(height)}`,
    width,
    height,
    role: "img",
    "aria-label": `${heading} ${geometry.orientation === "vertical" ? "垂直版" : "水平版"}`,
    class: "tournament-bracket-exploration-svg",
  });
  const title = svgElement("title");
  title.textContent = `${heading} ${geometry.orientation === "vertical" ? "垂直版" : "水平版"}`;
  const description = svgElement("desc");
  description.textContent = "実線は勝者、破線は敗者の進路です。表示文字はチーム名だけです。";
  svg.append(title, description);
  for (const segment of [...geometry.segments].sort(
    (left, right) => (left.outcome === "loser" ? 0 : 1) - (right.outcome === "loser" ? 0 : 1),
  )) {
    const transformed = transformedSegment(segment, geometry, slotByKey);
    const path = svgElement("path", {
      d: `M ${String(transformed.start.x)} ${String(transformed.start.y)} L ${String(transformed.end.x)} ${String(transformed.end.y)}`,
      class: `bracket-exploration-line ${segment.outcome}`,
      "data-owner-id": segment.ownerId,
    });
    const pathTitle = svgElement("title");
    pathTitle.textContent = `${segment.ownerId} ${segment.outcome === "winner" ? "勝者" : "敗者"}`;
    path.append(pathTitle);
    svg.append(path);
  }
  for (const slot of slots) {
    const group = svgElement("g", {
      class: "bracket-exploration-slot",
      "data-entry-key": slot.key,
      "aria-label": slot.fullLabel,
    });
    group.append(svgElement("rect", {
      x: slot.center.x - slot.width / 2,
      y: slot.center.y - slot.height / 2,
      width: slot.width,
      height: slot.height,
      class: "bracket-exploration-box",
    }));
    const label = svgElement("text", {
      x: slot.center.x,
      y: slot.center.y + 5,
      class: "bracket-exploration-team",
      "text-anchor": "middle",
    });
    label.textContent = slot.label;
    group.append(label);
    svg.append(group);
  }
  for (const matchLabel of geometry.matchLabels) {
    const center = transformedPoint(matchLabel.center, geometry);
    const label = svgElement("text", {
      x: center.x,
      class: "bracket-exploration-match-label",
      "text-anchor": "middle",
      "dominant-baseline": "middle",
      "data-match-id": matchLabel.matchId,
    });
    const firstLineY = center.y - (matchLabel.lines.length - 1) * 7;
    matchLabel.lines.forEach((line, index) => {
      const lineElement = svgElement("tspan", {
        x: center.x,
        ...(index === 0 ? { y: firstLineY } : { dy: 14 }),
      });
      lineElement.textContent = line;
      label.append(lineElement);
    });
    const labelTitle = svgElement("title");
    labelTitle.textContent = matchLabel.text;
    label.append(labelTitle);
    svg.append(label);
  }
  figure.append(svg);
  return figure;
}
