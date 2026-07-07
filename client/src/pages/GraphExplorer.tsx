import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, GitFork, Loader2, Maximize2, Minus, Plus, RotateCcw, Search } from 'lucide-react';
import api from '../lib/api';
import DocumentViewerModal, { type DocumentReference } from '../components/DocumentViewerModal';
import Skeleton from '../components/Skeleton';
import SelectField from '../components/SelectField';
import { useProjectSpaceStore } from '../stores/useProjectSpaceStore';

interface GraphMetadata {
  filename?: string | null;
  file_id?: string | null;
  chunk_id?: string | null;
  chunk_index?: number | string | null;
  retrieval_mode?: string;
  graph_entities?: string[];
  graph_relations?: GraphRelation[];
}

interface GraphRelation {
  type?: string | null;
  from?: string | null;
  to?: string | null;
  confidence?: number | string | null;
  evidence?: string | null;
}

interface GraphResult {
  id?: string;
  chunk_id?: string;
  file_id?: string;
  filename?: string;
  content?: string;
  score?: number;
  similarity?: number;
  retrieval_score?: number;
  graph_score?: number;
  metadata?: GraphMetadata;
}

interface GraphSearchResponse {
  results?: GraphResult[];
}

type GraphNodeType = 'knowledge' | 'tag';

interface GraphSourceRef {
  fileId?: string | null;
  filename: string;
  content: string;
  chunkIndex?: number | string | null;
}

interface GraphNode {
  id: string;
  label: string;
  type: GraphNodeType;
  x: number;
  y: number;
  count?: number;
  sources: GraphSourceRef[];
  pinned?: boolean;
}

interface GraphEdge {
  id: string;
  from: string;
  to: string;
  label: string;
  type: 'related' | 'semantic';
  count: number;
  sources: GraphSourceRef[];
  showLabel?: boolean;
  confidence?: number;
  evidence?: string;
}

interface GraphViewData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

interface EntityStat {
  count: number;
  sources: GraphSourceRef[];
  sourceKeys: Set<string>;
}

interface EdgeStat {
  left: string;
  right: string;
  count: number;
  sources: GraphSourceRef[];
  sourceKeys: Set<string>;
  relationType?: string;
  confidence?: number;
  evidence?: string;
}

interface GraphLabels {
  related: string;
  unknownSource: string;
  relationTypes: Record<string, string>;
}

const GRAPH_WIDTH = 1180;
const GRAPH_HEIGHT = 590;
const GRAPH_CENTER = { x: GRAPH_WIDTH / 2, y: GRAPH_HEIGHT / 2 };
const ENTITY_RING = { x: 430, y: 210 };
const MIN_ENTITY_NODES = 10;
const MAX_ENTITY_NODES = 30;
const MAX_EXTRA_ENTITY_EDGES = 4;
const MAX_ENTITIES_PER_CHUNK = 10;

const nodeStyles: Record<GraphNodeType, { fill: string; soft: string; stroke: string; text: string }> = {
  knowledge: { fill: '#10b981', soft: '#ecfdf5', stroke: '#86efac', text: '#047857' },
  tag: { fill: '#8b5cf6', soft: '#f5f3ff', stroke: '#c4b5fd', text: '#6d28d9' },
};

const stripMarkdownExtension = (value?: string | null) => (
  value || ''
).replace(/\.(?:md|markdown)$/i, '').trim();

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const getMaxEntityNodes = (resultLimit: number) => clamp(Math.round(resultLimit * 0.85), MIN_ENTITY_NODES, MAX_ENTITY_NODES);

const normalizeEntityId = (value: string) => value.trim().toLowerCase().replace(/\s+/g, '-').slice(0, 80);

const splitNodeLabel = (value: string, maxChars = 12, maxLines = 2) => {
  const cleanValue = value.replace(/\s+/g, ' ').trim();
  if (!cleanValue) return ['-'];

  const lines: string[] = [];
  let cursor = 0;
  while (cursor < cleanValue.length && lines.length < maxLines) {
    const next = cleanValue.slice(cursor, cursor + maxChars);
    lines.push(next);
    cursor += maxChars;
  }

  if (cursor < cleanValue.length && lines.length > 0) {
    lines[lines.length - 1] = `${lines[lines.length - 1].slice(0, Math.max(1, maxChars - 1))}...`;
  }

  return lines;
};

const getResultSourceName = (result: GraphResult, fallback: string) => {
  const metadata = result.metadata;
  return stripMarkdownExtension(metadata?.filename || result.filename || metadata?.file_id || result.file_id || fallback);
};

const getRingPoint = (angle: number, ring: { x: number; y: number }) => ({
  x: GRAPH_CENTER.x + Math.cos(angle) * ring.x,
  y: GRAPH_CENTER.y + Math.sin(angle) * ring.y,
});

const getEvenAngle = (index: number, count: number) => {
  if (count <= 1) return 0;
  return (-Math.PI / 2) + (2 * Math.PI * index) / count;
};

const clampGraphNode = (node: GraphNode) => {
  if (node.pinned) return node;
  return {
    ...node,
    x: clamp(node.x, 86, GRAPH_WIDTH - 86),
    y: clamp(node.y, 76, GRAPH_HEIGHT - 76),
  };
};

const relaxGraphNodes = (nodes: GraphNode[]) => {
  const relaxed = nodes.map((node) => ({ ...node }));

  for (let iteration = 0; iteration < 52; iteration += 1) {
    for (let i = 0; i < relaxed.length; i += 1) {
      const current = relaxed[i];

      for (let j = i + 1; j < relaxed.length; j += 1) {
        const other = relaxed[j];

        const dx = other.x - current.x;
        const dy = other.y - current.y;
        const distance = Math.max(Math.sqrt(dx * dx + dy * dy), 0.01);
        const minDistance = 96;

        if (distance >= minDistance) continue;

        const push = (minDistance - distance) / 2;
        const pushX = (dx / distance) * push;
        const pushY = (dy / distance) * push;
        if (current.pinned) {
          other.x += pushX * 2;
          other.y += pushY * 2;
        } else if (other.pinned) {
          current.x -= pushX * 2;
          current.y -= pushY * 2;
        } else {
          current.x -= pushX;
          current.y -= pushY;
          other.x += pushX;
          other.y += pushY;
        }
      }
    }

    for (let i = 0; i < relaxed.length; i += 1) {
      relaxed[i] = clampGraphNode(relaxed[i]);
    }
  }

  return relaxed;
};

const buildSourceRef = (result: GraphResult, fallback: string): GraphSourceRef => {
  const metadata = result.metadata;
  return {
    fileId: metadata?.file_id || result.file_id || null,
    filename: getResultSourceName(result, fallback),
    content: result.content || '',
    chunkIndex: metadata?.chunk_index ?? null,
  };
};

const buildSourceKey = (source: GraphSourceRef) => (
  `${source.fileId || source.filename}:${source.chunkIndex ?? ''}:${source.content.slice(0, 48)}`
);

const uniqueEntities = (entities: string[] = []) => {
  const seen = new Set<string>();
  const values: string[] = [];
  for (const entity of entities) {
    const trimmed = entity.trim();
    const key = trimmed.toLowerCase();
    if (!trimmed || seen.has(key)) continue;
    seen.add(key);
    values.push(trimmed);
  }
  return values.slice(0, MAX_ENTITIES_PER_CHUNK);
};

const normalizeRelationType = (value?: string | null) => String(value || 'RELATED')
  .trim()
  .toUpperCase()
  .replace(/[^A-Z0-9_]+/g, '_');

const getRelationLabel = (relationType: string | undefined, labels: GraphLabels) => {
  const normalized = normalizeRelationType(relationType);
  return labels.relationTypes[normalized] || labels.related;
};

const selectReadableEdges = (candidates: EdgeStat[], entityNames: string[]) => {
  const parent = new Map(entityNames.map((entity) => [entity, entity]));
  const find = (entity: string): string => {
    const current = parent.get(entity) || entity;
    if (current === entity) return current;
    const root = find(current);
    parent.set(entity, root);
    return root;
  };
  const union = (left: string, right: string) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot === rightRoot) return false;
    parent.set(rightRoot, leftRoot);
    return true;
  };

  const sorted = [...candidates].sort((a, b) => b.count - a.count || a.left.localeCompare(b.left, 'zh-Hans-CN'));
  const selected: EdgeStat[] = [];
  const selectedKeys = new Set<string>();

  for (const edge of sorted) {
    if (!union(edge.left, edge.right)) continue;
    selected.push(edge);
    selectedKeys.add(`${edge.left}::${edge.right}`);
    if (selected.length >= Math.max(0, entityNames.length - 1)) break;
  }

  for (const edge of sorted) {
    if (selected.length >= entityNames.length - 1 + MAX_EXTRA_ENTITY_EDGES) break;
    const edgeKey = `${edge.left}::${edge.right}`;
    if (selectedKeys.has(edgeKey) || edge.count <= 1) continue;
    selected.push(edge);
    selectedKeys.add(edgeKey);
  }

  return selected;
};

const buildGraphViewData = (
  results: GraphResult[],
  labels: GraphLabels,
  resultLimit: number
): GraphViewData => {
  const edges: GraphEdge[] = [];

  const visibleResults = results.slice(0, resultLimit);
  const maxEntityNodes = getMaxEntityNodes(resultLimit);
  const entityStats = new Map<string, EntityStat>();
  const edgeStats = new Map<string, EdgeStat>();

  visibleResults.forEach((result) => {
    const semanticRelations = (result.metadata?.graph_relations || []).filter((relation) => (
      relation?.from && relation?.to
    ));
    const relationEntities = semanticRelations.flatMap((relation) => [String(relation.from), String(relation.to)]);
    const entities = uniqueEntities([...(result.metadata?.graph_entities || []), ...relationEntities]);
    if (entities.length === 0) return;

    const source = buildSourceRef(result, labels.unknownSource);
    const sourceKey = buildSourceKey(source);

    for (const entity of entities) {
      const stat = entityStats.get(entity) || { count: 0, sources: [], sourceKeys: new Set<string>() };
      stat.count += 1;
      if (!stat.sourceKeys.has(sourceKey)) {
        stat.sourceKeys.add(sourceKey);
        stat.sources.push(source);
      }
      entityStats.set(entity, stat);
    }

    for (let leftIndex = 0; leftIndex < entities.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < entities.length; rightIndex += 1) {
        const pair = [entities[leftIndex], entities[rightIndex]].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
        const edgeKey = `${pair[0]}::${pair[1]}`;
        const stat = edgeStats.get(edgeKey) || {
          left: pair[0],
          right: pair[1],
          count: 0,
          sources: [],
          sourceKeys: new Set<string>(),
        };

        stat.count += 1;
        if (!stat.sourceKeys.has(sourceKey)) {
          stat.sourceKeys.add(sourceKey);
          stat.sources.push(source);
        }
        edgeStats.set(edgeKey, stat);
      }
    }

    for (const relation of semanticRelations) {
      const left = String(relation.from || '').trim();
      const right = String(relation.to || '').trim();
      if (!left || !right || left === right) continue;
      const relationType = normalizeRelationType(relation.type);
      const edgeKey = `${left}::${right}::${relationType}`;
      const confidence = Number(relation.confidence || 0);
      const stat = edgeStats.get(edgeKey) || {
        left,
        right,
        count: 0,
        sources: [],
        sourceKeys: new Set<string>(),
        relationType,
        confidence: Number.isFinite(confidence) ? confidence : 0,
        evidence: String(relation.evidence || ''),
      };

      stat.count += 2;
      stat.relationType = relationType;
      if (Number.isFinite(confidence) && confidence > (stat.confidence || 0)) {
        stat.confidence = confidence;
      }
      if (relation.evidence && !stat.evidence) {
        stat.evidence = String(relation.evidence);
      }
      if (!stat.sourceKeys.has(sourceKey)) {
        stat.sourceKeys.add(sourceKey);
        stat.sources.push(source);
      }
      edgeStats.set(edgeKey, stat);
    }
  });

  const topEntities = Array.from(entityStats.entries())
    .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0], 'zh-Hans-CN'))
    .slice(0, maxEntityNodes);

  const visibleEntityNames = new Set(topEntities.map(([entity]) => entity));
  const nodeIds = new Map(topEntities.map(([entity], index) => [entity, `entity-${normalizeEntityId(entity)}-${index}`]));
  const strongestEntity = topEntities[0]?.[0];
  const nodes: GraphNode[] = topEntities.map(([entity, stat], index) => {
    const isCenter = entity === strongestEntity;
    const point = isCenter
      ? GRAPH_CENTER
      : getRingPoint(getEvenAngle(index - 1, Math.max(topEntities.length - 1, 1)), ENTITY_RING);

    return {
      id: nodeIds.get(entity)!,
      label: entity,
      type: stat.count >= 3 ? 'knowledge' : 'tag',
      x: point.x,
      y: point.y,
      count: stat.count,
      sources: stat.sources,
      pinned: isCenter,
    };
  });

  const readableEdges = selectReadableEdges(
    Array.from(edgeStats.values())
    .filter((edge) => visibleEntityNames.has(edge.left) && visibleEntityNames.has(edge.right))
    .sort((a, b) => b.count - a.count || a.left.localeCompare(b.left, 'zh-Hans-CN')),
    topEntities.map(([entity]) => entity)
  );

  readableEdges.forEach((edge) => {
      const leftNodeId = nodeIds.get(edge.left);
      const rightNodeId = nodeIds.get(edge.right);
      if (!leftNodeId || !rightNodeId) return;
      edges.push({
        id: `edge-${leftNodeId}-${rightNodeId}`,
        from: leftNodeId,
        to: rightNodeId,
        label: edge.relationType
          ? `${getRelationLabel(edge.relationType, labels)}${edge.confidence ? ` ${Math.round(edge.confidence * 100)}%` : ''}`
          : `${labels.related}${edge.count > 1 ? ` ${edge.count}` : ''}`,
        type: edge.relationType ? 'semantic' : 'related',
        count: edge.count,
        sources: edge.sources,
        confidence: edge.confidence,
        evidence: edge.evidence,
        showLabel: Boolean(edge.relationType),
      });
    });

  return { nodes: relaxGraphNodes(nodes), edges };
};

export default function GraphExplorerPage() {
  const { t } = useTranslation();
  const { projectSpaces, currentProjectSpaceId, fetchProjectSpaces } = useProjectSpaceStore();
  const initialQuery = useMemo(() => new URLSearchParams(window.location.search).get('q')?.trim() || '', []);
  const hasAutoRunFromUrl = useRef(false);
  const [query, setQuery] = useState(initialQuery);
  const [selectedProjectSpaceId, setSelectedProjectSpaceId] = useState('');
  const [limit, setLimit] = useState(12);
  const [results, setResults] = useState<GraphResult[]>([]);
  const [hasSearched, setHasSearched] = useState(false);
  const [activeQuery, setActiveQuery] = useState(initialQuery);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [previewDocument, setPreviewDocument] = useState<DocumentReference | null>(null);
  const [zoom, setZoom] = useState(1);
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void fetchProjectSpaces();
  }, [fetchProjectSpaces]);

  useEffect(() => {
    if (!selectedProjectSpaceId && currentProjectSpaceId) {
      setSelectedProjectSpaceId(currentProjectSpaceId);
    }
  }, [currentProjectSpaceId, selectedProjectSpaceId]);

  const loadGraphOverview = useCallback(async () => {
    setIsSearching(true);
    setError(null);

    try {
      const { data } = await api.post<GraphSearchResponse>('/rag-workbench/graph/list', {
        project_space_id: selectedProjectSpaceId || undefined,
        limit,
      });
      setResults(data.results || []);
      setActiveQuery('');
      setHasSearched(true);
    } catch (searchError) {
      console.error('Failed to load RAG graph overview:', searchError);
      setError(t('graphExplorer.loadFailed'));
    } finally {
      setIsSearching(false);
    }
  }, [limit, selectedProjectSpaceId, t]);

  const searchGraph = useCallback(async (overrideQuery?: string) => {
    const trimmedQuery = (overrideQuery ?? query).trim();
    if (!trimmedQuery) {
      await loadGraphOverview();
      return;
    }

    setIsSearching(true);
    setError(null);

    try {
      const { data } = await api.post<GraphSearchResponse>('/rag-workbench/graph/search', {
        query: trimmedQuery,
        project_space_id: selectedProjectSpaceId || undefined,
        limit,
      });
      setResults(data.results || []);
      setActiveQuery(trimmedQuery);
      setHasSearched(true);
    } catch (searchError) {
      console.error('Failed to search RAG graph:', searchError);
      setError(t('graphExplorer.loadFailed'));
    } finally {
      setIsSearching(false);
    }
  }, [limit, loadGraphOverview, query, selectedProjectSpaceId, t]);

  useEffect(() => {
    if (!initialQuery || hasAutoRunFromUrl.current) return;

    hasAutoRunFromUrl.current = true;
    void searchGraph(initialQuery);
  }, [initialQuery, searchGraph]);

  useEffect(() => {
    if (initialQuery) return;
    void loadGraphOverview();
  }, [initialQuery, loadGraphOverview]);

  const graphData = useMemo(() => buildGraphViewData(
    results,
    {
      related: t('graphExplorer.relationRelated'),
      unknownSource: t('ragWorkbench.unknownSource'),
      relationTypes: {
        DEPENDS_ON: t('graphExplorer.relationTypes.dependsOn'),
        CONFLICTS_WITH: t('graphExplorer.relationTypes.conflictsWith'),
        SUPPORTS: t('graphExplorer.relationTypes.supports'),
        REPLACES: t('graphExplorer.relationTypes.replaces'),
        RELATED: t('graphExplorer.relationRelated'),
      },
    },
    limit
  ), [limit, results, t]);

  const selectedNode = useMemo(
    () => graphData.nodes.find((node) => node.id === selectedNodeId) || null,
    [graphData.nodes, selectedNodeId]
  );
  const graphNodeById = useMemo(
    () => new Map(graphData.nodes.map((node) => [node.id, node])),
    [graphData.nodes]
  );

  const connectedNodeIds = useMemo(() => {
    if (!selectedNodeId) return new Set<string>();
    const ids = new Set<string>([selectedNodeId]);
    for (const edge of graphData.edges) {
      if (edge.from === selectedNodeId) ids.add(edge.to);
      if (edge.to === selectedNodeId) ids.add(edge.from);
    }
    return ids;
  }, [graphData.edges, selectedNodeId]);

  const resetGraphView = useCallback(() => {
    setZoom(1);
    setSelectedNodeId(null);
  }, []);

  const openNodeSource = useCallback((node: GraphNode) => {
    setSelectedNodeId(node.id);

    const source = node.sources.find((item) => item.fileId && item.content.trim())
      || node.sources.find((item) => item.fileId);
    if (!source?.fileId) return;

    const parsedChunkIndex = typeof source.chunkIndex === 'number'
      ? source.chunkIndex
      : Number.parseInt(String(source.chunkIndex ?? ''), 10);

    setPreviewDocument({
      id: source.fileId,
      filename: source.filename,
      citationContent: source.content || node.label,
      chunkIndex: Number.isFinite(parsedChunkIndex) ? parsedChunkIndex : undefined,
    });
  }, []);

  return (
    <div className="flex h-full flex-col bg-bg-base text-text-main transition-colors duration-300">
      <div className="hidden items-center justify-between gap-4 border-b border-border bg-bg-sidebar p-4 md:flex">
        <div className="flex items-center gap-2">
          <GitFork className="h-5 w-5 text-primary" />
          <div>
            <h1 className="text-xl font-semibold">{t('graphExplorer.title')}</h1>
            <p className="text-sm text-text-muted">{t('graphExplorer.subtitle')}</p>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 md:p-6">
        <div className="mx-auto flex max-w-7xl flex-col gap-5">
          <div className="md:hidden">
            <h1 className="text-xl font-semibold">{t('graphExplorer.title')}</h1>
            <p className="mt-1 text-sm text-text-muted">{t('graphExplorer.subtitle')}</p>
          </div>

          {error && (
            <div className="flex items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-300">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {error}
            </div>
          )}

          <section className="rounded-lg border border-border bg-bg-sidebar p-4">
            <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_220px_120px_auto] lg:items-end">
              <label className="min-w-0">
                <span className="mb-2 block text-xs font-semibold uppercase tracking-wide text-text-muted">
                  {t('graphExplorer.queryLabel')}
                </span>
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void searchGraph();
                  }}
                  className="h-11 w-full rounded-lg border border-border bg-bg-base px-3 text-sm text-text-main outline-none transition-colors placeholder:text-text-muted focus:border-primary focus:ring-2 focus:ring-primary/20"
                  placeholder={t('graphExplorer.queryPlaceholder')}
                />
              </label>

              <label>
                <span className="mb-2 block text-xs font-semibold uppercase tracking-wide text-text-muted">
                  {t('usage.workspace')}
                </span>
                <SelectField
                  value={selectedProjectSpaceId}
                  onChange={(event) => setSelectedProjectSpaceId(event.target.value)}
                  className="w-full"
                  selectClassName="h-11"
                >
                  <option value="">{t('ragEval.allWorkspaces')}</option>
                  {projectSpaces.map((space) => (
                    <option key={space.id} value={space.id}>{space.name}</option>
                  ))}
                </SelectField>
              </label>

              <label>
                <span className="mb-2 block text-xs font-semibold uppercase tracking-wide text-text-muted">
                  {t('graphExplorer.chunkLimit')}
                </span>
                <input
                  type="number"
                  min={1}
                  max={30}
                  value={limit}
                  onChange={(event) => setLimit(Math.min(30, Math.max(1, Number(event.target.value) || 1)))}
                  className="h-11 w-full rounded-lg border border-border bg-bg-base px-3 text-sm outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-primary/20"
                />
                <span className="mt-1 block text-[11px] leading-snug text-text-muted">
                  {t('graphExplorer.chunkLimitHint', { nodes: getMaxEntityNodes(limit) })}
                </span>
              </label>

              <button
                onClick={() => void searchGraph()}
                disabled={isSearching}
                className="flex h-11 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-white transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isSearching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                {isSearching ? t('common.loading') : t('graphExplorer.search')}
              </button>
            </div>
          </section>

          {isSearching && !hasSearched ? (
            <div className="rounded-lg border border-border bg-white p-6">
              <Skeleton className="h-[520px] rounded-lg" />
            </div>
          ) : (
            <section className="overflow-hidden rounded-lg border border-border bg-white text-gray-900 shadow-sm">
              <div className="flex flex-col gap-2 border-b border-gray-100 px-4 py-3 md:flex-row md:items-center md:justify-between">
                <div>
                  <h2 className="text-base font-semibold text-gray-950">{t('graphExplorer.graphCanvasTitle')}</h2>
                  <p className="text-xs text-gray-500">
                    {activeQuery
                      ? t('graphExplorer.focusedOn', { query: activeQuery, count: results.length })
                      : t('graphExplorer.overviewHint', { count: results.length })}
                  </p>
                  <p className="mt-1 text-xs text-gray-400">
                    {t('graphExplorer.visibleGraphStats', { nodes: graphData.nodes.length, chunks: results.length })}
                  </p>
                </div>
                <p className="text-xs text-gray-400">{t('graphExplorer.graphHint')}</p>
              </div>

              <div className="relative overflow-hidden bg-white">
                {isSearching && (
                  <div className="absolute inset-0 z-20 flex items-center justify-center bg-white/70 text-sm text-gray-500 backdrop-blur-sm">
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    {t('common.loading')}
                  </div>
                )}

                {results.length === 0 && hasSearched ? (
                  <div className="flex min-h-[520px] flex-col items-center justify-center text-center text-gray-500">
                    <GitFork className="mb-3 h-10 w-10 text-primary" />
                    <p className="text-sm">{t('graphExplorer.emptyResults')}</p>
                  </div>
                ) : (
                  <div
                    className="relative min-h-[590px] overflow-auto"
                    onClick={() => setSelectedNodeId(null)}
                  >
                    <svg
                      width={GRAPH_WIDTH}
                      height={GRAPH_HEIGHT}
                      viewBox={`0 0 ${GRAPH_WIDTH} ${GRAPH_HEIGHT}`}
                      className="mx-auto block h-auto min-w-[980px] max-w-full"
                      role="img"
                      aria-label={t('graphExplorer.graphCanvasTitle')}
                    >
                      <defs>
                        <marker id="graph-arrow-purple" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                          <path d="M 0 0 L 10 5 L 0 10 z" fill="#a78bfa" />
                        </marker>
                        <filter id="node-shadow" x="-30%" y="-30%" width="160%" height="160%">
                          <feDropShadow dx="0" dy="8" stdDeviation="8" floodColor="#0f172a" floodOpacity="0.10" />
                        </filter>
                      </defs>

                      <g transform={`translate(${GRAPH_CENTER.x} ${GRAPH_CENTER.y}) scale(${zoom}) translate(${-GRAPH_CENTER.x} ${-GRAPH_CENTER.y})`}>
                        {graphData.edges.map((edge) => {
                          const from = graphNodeById.get(edge.from);
                          const to = graphNodeById.get(edge.to);
                          if (!from || !to) return null;
                          const isConnected = !selectedNodeId || edge.from === selectedNodeId || edge.to === selectedNodeId;
                          const midX = (from.x + to.x) / 2;
                              const midY = (from.y + to.y) / 2;
                              const shouldShowLabel = edge.showLabel || edge.from === selectedNodeId || edge.to === selectedNodeId;
                              const labelWidth = Math.max(34, edge.label.length * 12 + 16);
                              const edgeColor = edge.type === 'semantic' ? '#0ea5e9' : '#a78bfa';

                              return (
                                <g key={edge.id} opacity={isConnected ? 0.72 : 0.1}>
                              <line
                                x1={from.x}
                                y1={from.y}
                                    x2={to.x}
                                    y2={to.y}
                                    stroke={edgeColor}
                                    strokeWidth={Math.min(2.4, 1 + edge.count * 0.24)}
                                    markerEnd="url(#graph-arrow-purple)"
                                  />
                              {shouldShowLabel && (
                                <>
                                  <rect
                                    x={midX - labelWidth / 2}
                                    y={midY - 10}
                                    width={labelWidth}
                                        height={18}
                                        rx={9}
                                        fill="#ffffff"
                                        stroke={edge.type === 'semantic' ? '#bae6fd' : '#e5e7eb'}
                                      />
                                      <text x={midX} y={midY + 4} textAnchor="middle" className={edge.type === 'semantic' ? 'fill-sky-700 text-[10px] font-medium' : 'fill-gray-500 text-[10px]'}>
                                        {edge.label}
                                      </text>
                                </>
                              )}
                            </g>
                          );
                        })}

                        {graphData.nodes.map((node) => {
                          const palette = nodeStyles[node.type];
                          const isConnected = !selectedNodeId || connectedNodeIds.has(node.id);
                          const isSelected = selectedNodeId === node.id;
                          const iconSize = 32;
                          const labelLines = splitNodeLabel(node.label, 12, 2);
                          const labelAbove = node.y > GRAPH_HEIGHT - 150;
                          const labelY = labelAbove ? -iconSize / 2 - labelLines.length * 13 : iconSize / 2 + 14;
                          const countLabel = node.count !== undefined && node.count > 1 ? String(node.count) : '';
                          const badgeWidth = Math.max(18, countLabel.length * 7 + 10);

                          return (
                            <g
                              key={node.id}
                              transform={`translate(${node.x} ${node.y})`}
                              opacity={isConnected ? 1 : 0.2}
                              className="cursor-pointer"
                              onClick={(event) => {
                                event.stopPropagation();
                                openNodeSource(node);
                              }}
                            >
                              {isSelected && (
                                <rect
                                  x={-70}
                                  y={-34}
                                  width={140}
                                  height={76}
                                  rx={18}
                                  fill={palette.soft}
                                  stroke={palette.stroke}
                                  strokeWidth={1.5}
                                />
                              )}
                              <rect
                                x={-iconSize / 2}
                                y={-iconSize / 2}
                                width={iconSize}
                                height={iconSize}
                                rx={9}
                                fill={palette.fill}
                                filter="url(#node-shadow)"
                              />
                              {node.type === 'knowledge' ? (
                                <path d="M 0 -8 C 5 -8 8 -4 8 0 C 8 6 0 9 0 9 C 0 9 -8 6 -8 0 C -8 -4 -5 -8 0 -8 Z M -3 -1 L -1 2 L 4 -4" fill="none" stroke="white" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                              ) : (
                                <path d="M -7 -3 V -7 H -3 L 8 4 L 4 8 Z M -4 -4 H -4.01" fill="none" stroke="white" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                              )}
                              <text
                                x={0}
                                y={labelY}
                                textAnchor="middle"
                                stroke="#ffffff"
                                strokeWidth={3}
                                paintOrder="stroke"
                                className="select-none fill-gray-700 text-[11px] font-medium"
                              >
                                {labelLines.map((line, index) => (
                                  <tspan key={`${node.id}-${line}-${index}`} x={0} dy={index === 0 ? 0 : 13}>
                                    {line}
                                  </tspan>
                                ))}
                              </text>
                              {countLabel && (
                                <g transform={`translate(${iconSize / 2 + 10} ${-iconSize / 2 - 3})`}>
                                  <rect
                                    x={-badgeWidth / 2}
                                    y={-9}
                                    width={badgeWidth}
                                    height={18}
                                    rx={9}
                                    fill="#ffffff"
                                    stroke={palette.stroke}
                                  />
                                  <text y={4} textAnchor="middle" className="fill-gray-500 text-[10px] font-semibold">
                                    {countLabel}
                                  </text>
                                </g>
                              )}
                            </g>
                          );
                        })}
                      </g>
                    </svg>

                    <div className="absolute bottom-3 left-4 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-gray-100 bg-white/90 px-3 py-2 text-[11px] text-gray-500 shadow-sm">
                      <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-emerald-500" />{t('graphExplorer.legendKnowledge')}</span>
                      <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-violet-500" />{t('graphExplorer.legendTags')}</span>
                      <span className="inline-flex items-center gap-1.5"><span className="h-px w-5 bg-violet-300" />{t('graphExplorer.relationRelated')}</span>
                      <span>{t('graphExplorer.nodeClickHint')}</span>
                    </div>

                    <div className="absolute bottom-3 right-4 flex items-center gap-1 rounded-lg border border-gray-100 bg-white/90 p-1 shadow-sm">
                      <button
                        onClick={(event) => {
                          event.stopPropagation();
                          resetGraphView();
                        }}
                        className="grid h-8 w-8 place-items-center rounded-md text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-900"
                        aria-label={t('graphExplorer.fitView')}
                        title={t('graphExplorer.fitView')}
                      >
                        <RotateCcw className="h-4 w-4" />
                      </button>
                      <button
                        onClick={(event) => {
                          event.stopPropagation();
                          setZoom((value) => clamp(value - 0.1, 0.75, 1.4));
                        }}
                        className="grid h-8 w-8 place-items-center rounded-md text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-900"
                        aria-label={t('graphExplorer.zoomOut')}
                        title={t('graphExplorer.zoomOut')}
                      >
                        <Minus className="h-4 w-4" />
                      </button>
                      <span className="min-w-12 text-center text-xs text-gray-500">{Math.round(zoom * 100)}%</span>
                      <button
                        onClick={(event) => {
                          event.stopPropagation();
                          setZoom((value) => clamp(value + 0.1, 0.75, 1.4));
                        }}
                        className="grid h-8 w-8 place-items-center rounded-md text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-900"
                        aria-label={t('graphExplorer.zoomIn')}
                        title={t('graphExplorer.zoomIn')}
                      >
                        <Plus className="h-4 w-4" />
                      </button>
                      <button
                        onClick={(event) => {
                          event.stopPropagation();
                          setZoom(1);
                        }}
                        className="grid h-8 w-8 place-items-center rounded-md text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-900"
                        aria-label={t('graphExplorer.fitView')}
                        title={t('graphExplorer.fitView')}
                      >
                        <Maximize2 className="h-4 w-4" />
                      </button>
                    </div>

                    {selectedNode && (
                      <div className="absolute right-4 top-4 max-w-xs rounded-xl border border-gray-100 bg-white/95 p-3 text-xs text-gray-600 shadow-lg">
                        <p className="font-semibold text-gray-950">{selectedNode.label}</p>
                        <p className="mt-1">{t(`graphExplorer.nodeType.${selectedNode.type}`)}</p>
                        <p className="mt-1 text-gray-400">{t('graphExplorer.sourceCount', { count: selectedNode.sources.length })}</p>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </section>
          )}
        </div>
      </div>
      <DocumentViewerModal
        document={previewDocument}
        onClose={() => setPreviewDocument(null)}
      />
    </div>
  );
}
