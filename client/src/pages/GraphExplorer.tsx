import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, GitFork, Loader2, Maximize2, Minus, Plus, RotateCcw, Search } from 'lucide-react';
import api from '../lib/api';
import { toSafeError } from '../lib/safeError';
import DocumentViewerModal, { type DocumentReference } from '../components/DocumentViewerModal';
import Skeleton from '../components/Skeleton';
import SelectField from '../components/SelectField';
import { useProjectSpaceStore } from '../stores/useProjectSpaceStore';
import { useShallow } from 'zustand/react/shallow';
import type { SourceLocator } from '../lib/sourceLocator';

interface GraphExtractionSummary {
  status?: string;
  attempted?: number;
  succeeded?: number;
  cache_hits?: number;
  fallbacks?: number;
  extractor_version?: string;
  ontology_version?: string;
}

interface GraphEntityDetail {
  entity_id?: string | null;
  name?: string | null;
  normalized_name?: string | null;
  entity_type?: string | null;
  entity_type_label?: string | null;
  aliases?: string[];
  scope_key?: string | null;
}

interface GraphMetadata {
  filename?: string | null;
  file_id?: string | null;
  chunk_id?: string | null;
  chunk_index?: number | string | null;
  retrieval_mode?: string;
  graph_entities?: string[];
  graph_entity_details?: GraphEntityDetail[];
  graph_relations?: GraphRelation[];
  graph_extraction?: GraphExtractionSummary;
  document_kind?: string | null;
  conversion_generation_id?: string | null;
  source_unit_ids?: string[];
  source_locator?: SourceLocator;
}

interface GraphRelation {
  type?: string | null;
  fact_id?: string | null;
  label?: string | null;
  from?: string | null;
  to?: string | null;
  from_entity_id?: string | null;
  to_entity_id?: string | null;
  from_entity_type?: string | null;
  to_entity_type?: string | null;
  confidence?: number | string | null;
  evidence?: string | null;
  polarity?: string | null;
  modality?: string | null;
  validation_status?: string | null;
  extraction_lane?: string | null;
  extraction_method?: string | null;
  evidence_chunk_ids?: Array<string | null>;
  evidence_refs?: Array<{ chunk_id?: string | null; span?: string | null }>;
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
  chunkId?: string | null;
  fileId?: string | null;
  filename: string;
  content: string;
  chunkIndex?: number | string | null;
  documentKind?: string | null;
  sourceLocator?: SourceLocator;
}

interface GraphNode {
  id: string;
  entityId?: string;
  label: string;
  type: GraphNodeType;
  ontologyType?: string;
  typeLabel?: string;
  aliases?: string[];
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
  type: 'semantic';
  count: number;
  sources: GraphSourceRef[];
  showLabel?: boolean;
  confidence?: number;
  evidence?: string;
  factId?: string;
  polarity?: string;
  modality?: string;
  extractionLane?: string;
  extractionMethod?: string;
}

interface GraphViewData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

interface EntityStat {
  label: string;
  entityId?: string;
  ontologyType?: string;
  typeLabel?: string;
  aliases: string[];
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
  factId?: string;
  relationLabel?: string;
  polarity?: string;
  modality?: string;
  extractionLane?: string;
  extractionMethod?: string;
}

interface GraphLabels {
  related: string;
  unknownSource: string;
  relationTypes: Record<string, string>;
}

const GRAPH_WIDTH = 1080;
const GRAPH_HEIGHT = 500;
const GRAPH_CENTER = { x: GRAPH_WIDTH / 2, y: GRAPH_HEIGHT / 2 };
const ENTITY_RING = { x: 370, y: 165 };
const COMPACT_ENTITY_RING = { x: 190, y: 165 };
const MIN_ENTITY_NODES = 10;
const MAX_ENTITY_NODES = 30;
const MAX_ENTITIES_PER_CHUNK = 10;
const MAX_VISIBLE_FACTS = 60;

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
    chunkId: result.id || result.chunk_id || metadata?.chunk_id || null,
    fileId: metadata?.file_id || result.file_id || null,
    filename: getResultSourceName(result, fallback),
    content: result.content || '',
    chunkIndex: metadata?.chunk_index ?? null,
    documentKind: metadata?.document_kind ?? null,
    sourceLocator: metadata?.source_locator,
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
  return labels.relationTypes[normalized] || normalized.replace(/_/g, ' ').toLowerCase();
};

const buildGraphViewData = (
  results: GraphResult[],
  labels: GraphLabels,
  resultLimit: number,
  compact = false,
): GraphViewData => {
  const edges: GraphEdge[] = [];

  const visibleResults = results.slice(0, resultLimit);
  const maxEntityNodes = getMaxEntityNodes(resultLimit);
  const entityStats = new Map<string, EntityStat>();
  const edgeStats = new Map<string, EdgeStat>();

  visibleResults.forEach((result) => {
    const metadata = result.metadata;
    const semanticRelations = (result.metadata?.graph_relations || []).filter((relation) => (
      relation?.from && relation?.to
    ));
    const source = buildSourceRef(result, labels.unknownSource);
    const sourceKey = buildSourceKey(source);
    const legacyScope = String(metadata?.file_id || result.file_id || source.filename || 'unknown');
    const details = metadata?.graph_entity_details || [];
    const detailsById = new Map(
      details
        .filter((detail) => String(detail.entity_id || '').trim())
        .map((detail) => [String(detail.entity_id), detail]),
    );
    const detailsByName = new Map<string, GraphEntityDetail[]>();
    for (const detail of details) {
      const nameKey = String(detail.normalized_name || detail.name || '').trim().toLowerCase();
      if (!nameKey) continue;
      detailsByName.set(nameKey, [...(detailsByName.get(nameKey) || []), detail]);
    }
    const encounteredEntities = new Map<string, {
      label: string;
      entityId?: string;
      ontologyType?: string;
      typeLabel?: string;
      aliases: string[];
    }>();
    const resolveEntity = (
      nameValue: string | null | undefined,
      idValue?: string | null,
      typeValue?: string | null,
    ) => {
      const label = String(nameValue || '').trim();
      const explicitId = String(idValue || '').trim();
      const nameKey = label.toLowerCase();
      const nameMatches = detailsByName.get(nameKey) || [];
      const detail = detailsById.get(explicitId) || (nameMatches.length === 1 ? nameMatches[0] : undefined);
      const entityId = explicitId || String(detail?.entity_id || '').trim();
      const key = entityId || `legacy:${legacyScope}:${nameKey}`;
      return {
        key,
        label: String(detail?.name || label).trim(),
        entityId: entityId || undefined,
        ontologyType: String(detail?.entity_type || typeValue || '').trim() || undefined,
        typeLabel: String(detail?.entity_type_label || '').trim() || undefined,
        aliases: (detail?.aliases || []).map(String).filter(Boolean),
      };
    };
    const rememberEntity = (entity: ReturnType<typeof resolveEntity>) => {
      if (!entity.key || !entity.label) return;
      encounteredEntities.set(entity.key, entity);
    };

    for (const detail of details) {
      rememberEntity(resolveEntity(detail.name, detail.entity_id, detail.entity_type));
    }
    for (const name of uniqueEntities(metadata?.graph_entities || [])) {
      const nameMatches = detailsByName.get(name.toLowerCase()) || [];
      if (nameMatches.length > 1) {
        nameMatches.forEach((detail) => rememberEntity(
          resolveEntity(detail.name, detail.entity_id, detail.entity_type),
        ));
      } else {
        rememberEntity(resolveEntity(name));
      }
    }

    for (const relation of semanticRelations) {
      const referencedChunkIds = new Set(
        [
          ...(relation.evidence_refs || []).map((reference) => reference.chunk_id),
          ...(relation.evidence_chunk_ids || []),
        ]
          .map((chunkId) => String(chunkId || '').trim())
          .filter(Boolean),
      );
      if (
        referencedChunkIds.size > 0
        && (!source.chunkId || !referencedChunkIds.has(String(source.chunkId)))
      ) {
        continue;
      }
      const left = String(relation.from || '').trim();
      const right = String(relation.to || '').trim();
      if (!left || !right) continue;
      const leftEntity = resolveEntity(left, relation.from_entity_id, relation.from_entity_type);
      const rightEntity = resolveEntity(right, relation.to_entity_id, relation.to_entity_type);
      if (leftEntity.key === rightEntity.key) continue;
      rememberEntity(leftEntity);
      rememberEntity(rightEntity);
      const relationType = normalizeRelationType(relation.type);
      const relationLabel = String(relation.label || '').trim();
      const edgeKey = String(relation.fact_id || `${leftEntity.key}::${rightEntity.key}::${relationType}::${relationLabel}::${relation.polarity || ''}::${relation.modality || ''}`);
      const confidence = Number(relation.confidence || 0);
      const stat = edgeStats.get(edgeKey) || {
        left: leftEntity.key,
        right: rightEntity.key,
        count: 0,
        sources: [],
        sourceKeys: new Set<string>(),
        relationType,
        relationLabel,
        factId: String(relation.fact_id || ''),
        confidence: Number.isFinite(confidence) ? confidence : 0,
        evidence: String(relation.evidence || ''),
        polarity: String(relation.polarity || 'affirmative'),
        modality: String(relation.modality || 'asserted'),
        extractionLane: String(relation.extraction_lane || 'legacy'),
        extractionMethod: String(relation.extraction_method || 'legacy'),
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

    for (const [entityKey, entity] of encounteredEntities) {
      const stat = entityStats.get(entityKey) || {
        label: entity.label,
        entityId: entity.entityId,
        ontologyType: entity.ontologyType,
        typeLabel: entity.typeLabel,
        aliases: [],
        count: 0,
        sources: [],
        sourceKeys: new Set<string>(),
      };
      stat.count += 1;
      stat.aliases = Array.from(new Set([...stat.aliases, ...entity.aliases]));
      if (!stat.sourceKeys.has(sourceKey)) {
        stat.sourceKeys.add(sourceKey);
        stat.sources.push(source);
      }
      entityStats.set(entityKey, stat);
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
      : getRingPoint(
        getEvenAngle(index - 1, Math.max(topEntities.length - 1, 1)),
        compact ? COMPACT_ENTITY_RING : ENTITY_RING,
      );

    return {
      id: nodeIds.get(entity)!,
      entityId: stat.entityId,
      label: stat.label,
      type: stat.ontologyType ? 'knowledge' : 'tag',
      ontologyType: stat.ontologyType,
      typeLabel: stat.typeLabel,
      aliases: stat.aliases,
      x: point.x,
      y: point.y,
      count: stat.count,
      sources: stat.sources,
      pinned: isCenter,
    };
  });

  const readableEdges = Array.from(edgeStats.values())
    .filter((edge) => visibleEntityNames.has(edge.left) && visibleEntityNames.has(edge.right))
    .sort((a, b) => b.count - a.count || a.left.localeCompare(b.left, 'zh-Hans-CN'))
    .slice(0, MAX_VISIBLE_FACTS);

  readableEdges.forEach((edge) => {
      const leftNodeId = nodeIds.get(edge.left);
      const rightNodeId = nodeIds.get(edge.right);
      if (!leftNodeId || !rightNodeId) return;
      edges.push({
        id: `edge-${edge.factId || `${leftNodeId}-${rightNodeId}-${normalizeRelationType(edge.relationType)}`}`,
        from: leftNodeId,
        to: rightNodeId,
        label: edge.relationLabel || getRelationLabel(edge.relationType, labels),
        type: 'semantic',
        count: edge.count,
        sources: edge.sources,
        confidence: edge.confidence,
        evidence: edge.evidence,
        factId: edge.factId,
        polarity: edge.polarity,
        modality: edge.modality,
        extractionLane: edge.extractionLane,
        extractionMethod: edge.extractionMethod,
        showLabel: true,
      });
    });

  return { nodes: relaxGraphNodes(nodes), edges };
};

export default function GraphExplorerPage() {
  const { t } = useTranslation();
  const { projectSpaces, currentProjectSpaceId, fetchProjectSpaces } = useProjectSpaceStore(useShallow((state) => ({
    projectSpaces: state.projectSpaces,
    currentProjectSpaceId: state.currentProjectSpaceId,
    fetchProjectSpaces: state.fetchProjectSpaces,
  })));
  const initialQuery = useMemo(() => new URLSearchParams(window.location.search).get('q')?.trim() || '', []);
  const hasAutoRunFromUrl = useRef(false);
  const graphRequestSeq = useRef(0);
  const [query, setQuery] = useState(initialQuery);
  const [selectedProjectSpaceId, setSelectedProjectSpaceId] = useState<string | null>(() => currentProjectSpaceId);
  const [limit, setLimit] = useState(12);
  const [results, setResults] = useState<GraphResult[]>([]);
  const [hasSearched, setHasSearched] = useState(false);
  const [activeQuery, setActiveQuery] = useState(initialQuery);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [previewDocument, setPreviewDocument] = useState<DocumentReference | null>(null);
  const [zoom, setZoom] = useState(1);
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isCompactGraph, setIsCompactGraph] = useState(() => window.matchMedia('(max-width: 767px)').matches);

  useEffect(() => {
    const mediaQuery = window.matchMedia('(max-width: 767px)');
    const updateCompactGraph = () => setIsCompactGraph(mediaQuery.matches);
    updateCompactGraph();
    mediaQuery.addEventListener('change', updateCompactGraph);
    return () => mediaQuery.removeEventListener('change', updateCompactGraph);
  }, []);

  useEffect(() => {
    void fetchProjectSpaces();
  }, [fetchProjectSpaces]);

  useEffect(() => {
    if (selectedProjectSpaceId === null && currentProjectSpaceId) {
      setSelectedProjectSpaceId(currentProjectSpaceId);
    }
  }, [currentProjectSpaceId, selectedProjectSpaceId]);

  const loadGraphOverview = useCallback(async () => {
    const requestId = graphRequestSeq.current + 1;
    graphRequestSeq.current = requestId;
    setIsSearching(true);
    setError(null);

    try {
      const { data } = await api.post<GraphSearchResponse>('/rag-workbench/graph/list', {
        project_space_id: selectedProjectSpaceId || undefined,
        limit,
      });
      if (requestId !== graphRequestSeq.current) return;
      setResults(data.results || []);
      setActiveQuery('');
      setHasSearched(true);
    } catch (searchError) {
      if (requestId !== graphRequestSeq.current) return;
      console.error('Failed to load RAG graph overview:', toSafeError(searchError));
      setError(t('graphExplorer.loadFailed'));
    } finally {
      if (requestId === graphRequestSeq.current) {
        setIsSearching(false);
      }
    }
  }, [limit, selectedProjectSpaceId, t]);

  const searchGraph = useCallback(async (overrideQuery?: string) => {
    const trimmedQuery = (overrideQuery ?? query).trim();
    if (!trimmedQuery) {
      await loadGraphOverview();
      return;
    }

    const requestId = graphRequestSeq.current + 1;
    graphRequestSeq.current = requestId;
    setIsSearching(true);
    setError(null);

    try {
      const { data } = await api.post<GraphSearchResponse>('/rag-workbench/graph/search', {
        query: trimmedQuery,
        project_space_id: selectedProjectSpaceId || undefined,
        limit,
      });
      if (requestId !== graphRequestSeq.current) return;
      setResults(data.results || []);
      setActiveQuery(trimmedQuery);
      setHasSearched(true);
    } catch (searchError) {
      if (requestId !== graphRequestSeq.current) return;
      console.error('Failed to search RAG graph:', toSafeError(searchError));
      setError(t('graphExplorer.loadFailed'));
    } finally {
      if (requestId === graphRequestSeq.current) {
        setIsSearching(false);
      }
    }
  }, [limit, loadGraphOverview, query, selectedProjectSpaceId, t]);

  useEffect(() => {
    if (!initialQuery || hasAutoRunFromUrl.current || selectedProjectSpaceId === null) return;

    hasAutoRunFromUrl.current = true;
    void searchGraph(initialQuery);
  }, [initialQuery, searchGraph, selectedProjectSpaceId]);

  useEffect(() => {
    if (initialQuery || selectedProjectSpaceId === null) return;
    void loadGraphOverview();
  }, [initialQuery, loadGraphOverview, selectedProjectSpaceId]);

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
        CONNECTS_TO: t('graphExplorer.relationTypes.connectsTo'),
        IMPACTS: t('graphExplorer.relationTypes.impacts'),
        USES: t('graphExplorer.relationTypes.uses'),
        PART_OF: t('graphExplorer.relationTypes.partOf'),
        RESPONSIBLE_FOR: t('graphExplorer.relationTypes.responsibleFor'),
        PROVIDES: t('graphExplorer.relationTypes.provides'),
        PAYS: t('graphExplorer.relationTypes.pays'),
        BELONGS_TO: t('graphExplorer.relationTypes.belongsTo'),
        IMPLEMENTS: t('graphExplorer.relationTypes.implements'),
        RELATED: t('graphExplorer.relationRelated'),
      },
    },
    limit,
    isCompactGraph,
  ), [isCompactGraph, limit, results, t]);

  const selectedNode = useMemo(
    () => graphData.nodes.find((node) => node.id === selectedNodeId) || null,
    [graphData.nodes, selectedNodeId]
  );
  const selectedEdge = useMemo(
    () => graphData.edges.find((edge) => edge.id === selectedEdgeId) || null,
    [graphData.edges, selectedEdgeId]
  );
  const extractionStatuses = useMemo(() => Array.from(new Set(
    results.map((result) => result.metadata?.graph_extraction?.status).filter(Boolean) as string[]
  )), [results]);
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
    setSelectedEdgeId(null);
  }, []);

  const openSource = useCallback((source: GraphSourceRef | undefined, citationContent: string) => {
    if (!source?.fileId) return;

    const parsedChunkIndex = typeof source.chunkIndex === 'number'
      ? source.chunkIndex
      : Number.parseInt(String(source.chunkIndex ?? ''), 10);

    setPreviewDocument({
      id: source.fileId,
      filename: source.filename,
      citationContent: source.content || citationContent,
      chunkIndex: Number.isFinite(parsedChunkIndex) ? parsedChunkIndex : undefined,
      document_kind: source.documentKind || undefined,
      source_locator: source.sourceLocator,
    });
  }, []);

  const openNodeSource = useCallback((node: GraphNode) => {
    setSelectedNodeId(node.id);
    setSelectedEdgeId(null);
    const source = node.sources.find((item) => item.fileId && item.content.trim())
      || node.sources.find((item) => item.fileId);
    openSource(source, node.label);
  }, [openSource]);

  return (
    <div className="flex h-full flex-col bg-bg-base text-text-main transition-colors duration-300">
      <div className="hidden items-center justify-between gap-4 border-b border-border bg-bg-sidebar px-4 py-3 md:flex">
        <div className="flex items-center gap-2">
          <GitFork className="h-5 w-5 text-primary" />
          <div>
            <h1 className="text-xl font-semibold">{t('graphExplorer.title')}</h1>
            <p className="text-sm text-text-muted">{t('graphExplorer.subtitle')}</p>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3 md:p-4">
        <div className="mx-auto flex max-w-7xl flex-col gap-3">
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

          <section className="rounded-lg border border-border bg-bg-sidebar p-3 shadow-sm">
            <div className="mb-2 flex flex-col gap-1 md:flex-row md:items-baseline md:gap-3">
              <h2 className="text-base font-semibold text-text-main">{t('graphExplorer.queryLabel')}</h2>
              <p className="text-xs leading-5 text-text-muted">
                {t('graphExplorer.chunkLimitHint', { nodes: getMaxEntityNodes(limit) })}
              </p>
            </div>

            <div className="grid gap-2 lg:grid-cols-[minmax(0,1fr)_230px_104px_auto] lg:items-end">
              <label className="min-w-0">
                <span className="sr-only">{t('graphExplorer.queryLabel')}</span>
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void searchGraph();
                  }}
                  className="h-10 w-full rounded-lg border border-border bg-bg-base px-3 text-sm text-text-main outline-none transition-colors placeholder:text-text-muted focus:border-primary focus:ring-2 focus:ring-primary/20"
                  placeholder={t('graphExplorer.queryPlaceholder')}
                />
              </label>

              <label>
                <span className="mb-2 block text-xs font-medium text-text-muted">
                  {t('usage.workspace')}
                </span>
                <SelectField
                  value={selectedProjectSpaceId ?? ''}
                  onChange={(event) => setSelectedProjectSpaceId(event.target.value)}
                  className="w-full"
                  selectClassName="h-10"
                >
                  <option value="">{t('ragEval.allWorkspaces')}</option>
                  {projectSpaces.map((space) => (
                    <option key={space.id} value={space.id}>{space.name}</option>
                  ))}
                </SelectField>
              </label>

              <label>
                <span className="mb-2 block text-xs font-medium text-text-muted">
                  {t('graphExplorer.chunkLimit')}
                </span>
                <input
                  type="number"
                  min={1}
                  max={30}
                  value={limit}
                  onChange={(event) => setLimit(Math.min(30, Math.max(1, Number(event.target.value) || 1)))}
                  className="h-10 w-full rounded-lg border border-border bg-bg-base px-3 text-sm outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-primary/20"
                />
              </label>

              <button
                onClick={() => void searchGraph()}
                disabled={isSearching}
                className="flex h-10 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-white transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isSearching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                {isSearching ? t('common.loading') : t('graphExplorer.search')}
              </button>
            </div>
          </section>

          {isSearching && !hasSearched ? (
            <div className="rounded-lg border border-border bg-white p-4">
              <Skeleton className="h-[440px] rounded-lg" />
            </div>
          ) : (
            <section className="overflow-hidden rounded-lg border border-border bg-white text-gray-900 shadow-sm">
              <div className="flex flex-col gap-2 border-b border-gray-100 px-4 py-2.5 md:flex-row md:items-center md:justify-between">
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
              {extractionStatuses.length > 0 && (
                <div data-testid="graph-extraction-status" className={`border-b px-4 py-2 text-xs ${extractionStatuses.some((status) => status.includes('fallback') || status === 'rules_only') ? 'border-amber-200 bg-amber-50 text-amber-800' : 'border-emerald-200 bg-emerald-50 text-emerald-800'}`}>
                  {t('graphExplorer.extractionStatusLabel')}: {extractionStatuses.map((status) => t(`graphExplorer.extractionStatus.${status}`)).join(' / ')}
                </div>
              )}

              <div className="relative overflow-hidden bg-white">
                {isSearching && (
                  <div className="absolute inset-0 z-20 flex items-center justify-center bg-white/70 text-sm text-gray-500 backdrop-blur-sm">
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    {t('common.loading')}
                  </div>
                )}

                {results.length === 0 && hasSearched ? (
                  <div className="flex min-h-[430px] flex-col items-center justify-center text-center text-gray-500">
                    <GitFork className="mb-3 h-10 w-10 text-primary" />
                    <p className="text-sm">{t('graphExplorer.emptyResults')}</p>
                  </div>
                ) : (
                  <div
                    className="relative min-h-[500px] overflow-hidden"
                    onClick={() => {
                      setSelectedNodeId(null);
                      setSelectedEdgeId(null);
                    }}
                  >
                    <svg
                      width={GRAPH_WIDTH}
                      height={GRAPH_HEIGHT}
                      viewBox={isCompactGraph ? `300 0 480 ${GRAPH_HEIGHT}` : `0 0 ${GRAPH_WIDTH} ${GRAPH_HEIGHT}`}
                      className="mx-auto block h-[380px] w-full md:h-auto"
                      role="img"
                      aria-label={t('graphExplorer.graphCanvasTitle')}
                    >
                      <defs>
                        <marker id="graph-arrow-semantic" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                          <path d="M 0 0 L 10 5 L 0 10 z" fill="#0ea5e9" />
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
                          const isSelectedEdge = selectedEdgeId === edge.id;
                          const midX = (from.x + to.x) / 2;
                              const midY = (from.y + to.y) / 2;
                              const shouldShowLabel = edge.showLabel || edge.from === selectedNodeId || edge.to === selectedNodeId;
                              const labelWidth = Math.max(34, edge.label.length * 12 + 16);
                              const edgeColor = edge.polarity === 'negative' ? '#ef4444' : edge.modality && edge.modality !== 'asserted' ? '#d97706' : '#0ea5e9';

                              return (
                                <g
                                  key={edge.id}
                                  data-testid={edge.factId ? `graph-fact-${edge.factId}` : undefined}
                                  opacity={isSelectedEdge ? 1 : isConnected ? 0.72 : 0.1}
                                  className="cursor-pointer"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    setSelectedNodeId(null);
                                    setSelectedEdgeId(edge.id);
                                  }}
                                >
                              <title>{[edge.label, edge.evidence].filter(Boolean).join(' — ')}</title>
                              <line
                                x1={from.x}
                                y1={from.y}
                                    x2={to.x}
                                    y2={to.y}
                                    stroke={edgeColor}
                                    strokeWidth={isSelectedEdge ? 3 : Math.min(2.4, 1 + edge.count * 0.24)}
                                    strokeDasharray={edge.polarity === 'negative' || (edge.modality && edge.modality !== 'asserted') ? '6 4' : undefined}
                                    markerEnd="url(#graph-arrow-semantic)"
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
                                        stroke="#bae6fd"
                                      />
                                      <text x={midX} y={midY + 4} textAnchor="middle" className="fill-sky-700 text-[10px] font-medium">
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
                          const iconSize = 30;
                          const labelLines = splitNodeLabel(node.label, 11, 2);
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
                      <span className="inline-flex items-center gap-1.5"><span className="h-px w-5 bg-sky-500" />{t('graphExplorer.legendEvidenceRelations')}</span>
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

                    {selectedEdge ? (
                      <div className="absolute right-4 top-4 max-w-sm rounded-xl border border-sky-100 bg-white/95 p-3 text-xs text-gray-600 shadow-lg">
                        <p className="font-semibold text-gray-950">{selectedEdge.label}</p>
                        <p className="mt-1 text-gray-500">{t('graphExplorer.factQualifiers', { polarity: selectedEdge.polarity || 'affirmative', modality: selectedEdge.modality || 'asserted' })}</p>
                        {selectedEdge.evidence && <p className="mt-2 border-l-2 border-sky-200 pl-2 leading-5 text-gray-700">{selectedEdge.evidence}</p>}
                        <p className="mt-2 text-gray-400">{selectedEdge.extractionLane || 'legacy'} · {selectedEdge.extractionMethod || 'legacy'}</p>
                        {selectedEdge.sources.some((source) => source.fileId) && (
                          <button
                            className="mt-2 rounded-md bg-sky-50 px-2 py-1 font-medium text-sky-700 hover:bg-sky-100"
                            onClick={(event) => {
                              event.stopPropagation();
                              openSource(selectedEdge.sources.find((source) => source.fileId), selectedEdge.evidence || selectedEdge.label);
                            }}
                          >
                            {t('graphExplorer.openEvidence')}
                          </button>
                        )}
                      </div>
                    ) : selectedNode && (
                      <div className="absolute right-4 top-4 max-w-xs rounded-xl border border-gray-100 bg-white/95 p-3 text-xs text-gray-600 shadow-lg">
                        <p className="font-semibold text-gray-950">{selectedNode.label}</p>
                        <p className="mt-1">
                          {selectedNode.typeLabel || selectedNode.ontologyType || t(`graphExplorer.nodeType.${selectedNode.type}`)}
                        </p>
                        {(selectedNode.aliases?.length || 0) > 0 && (
                          <p className="mt-1 text-gray-500">{selectedNode.aliases?.join(' · ')}</p>
                        )}
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
