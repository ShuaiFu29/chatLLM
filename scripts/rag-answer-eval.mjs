import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { toSafeError } from './safe-error.mjs';

const round4 = (value) => Number((Number.isFinite(value) ? value : 0).toFixed(4));
export const SCORER_VERSION = '2.0.0';

const compactText = (value = '') => String(value)
  .normalize('NFKC')
  .toLowerCase()
  .replace(/[^\p{L}\p{N}%]+/gu, '');

const stripCitations = (value = '') => String(value).replace(/\[\s*Source\s+\d+\s*\]/gi, ' ');

const splitCsv = (value = '') => String(value)
  .split(/[,，]/)
  .map((item) => item.trim())
  .filter(Boolean);

const parseMarkdownRow = (line) => {
  const trimmed = String(line || '').trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return [];
  return trimmed.slice(1, -1).split('|').map((cell) => cell.trim());
};

export function parseAnswerTable(markdown) {
  const rows = String(markdown || '').split(/\r?\n/).map(parseMarkdownRow).filter((row) => row.length >= 5);
  const headerIndex = rows.findIndex((row) => (
    row[0].toLowerCase() === '编号'
    && row[1].toLowerCase() === 'question'
    && row[2].toLowerCase() === 'expected_answer'
  ));
  if (headerIndex < 0) return [];

  return rows.slice(headerIndex + 1)
    .filter((row) => !row.every((cell) => /^:?-{3,}:?$/.test(cell)))
    .filter((row) => /^E\d+$/i.test(row[0]))
    .map((row) => ({
      id: row[0],
      question: row[1],
      expectedAnswer: row[2],
      expectedKeywords: splitCsv(row[3]),
      expectedSources: splitCsv(row[4]),
    }));
}

export function buildQuestionManifest(expectations) {
  return {
    createdAt: new Date().toISOString(),
    kind: 'rag-answer-questions-only',
    answerDataUsedDuringGeneration: false,
    cases: (expectations || []).map(({ id, question }) => ({ id, question })),
  };
}

const conceptAlternatives = (concept) => String(concept || '')
  .split(/[|｜]/)
  .map((item) => item.trim())
  .filter(Boolean);

const semanticCanonical = (value) => compactText(value)
  .replace(/不可以|无法|不得|不可/g, '不能')
  .replace(/所有|完全|全量/g, '全部')
  .replace(/现行/g, '当前')
  .replace(/作废|失效/g, '废止')
  .replace(/解决/g, '修复')
  .replace(/佐证|支撑/g, '证据');

const lcsLength = (left, right) => {
  if (!left || !right) return 0;
  const previous = new Uint16Array(right.length + 1);
  const current = new Uint16Array(right.length + 1);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = left[leftIndex - 1] === right[rightIndex - 1]
        ? previous[rightIndex - 1] + 1
        : Math.max(previous[rightIndex], current[rightIndex - 1]);
    }
    previous.set(current);
    current.fill(0);
  }
  return previous[right.length];
};

const sentenceCandidates = (answer) => stripCitations(answer)
  .split(/[。！？!?；;\n]+/)
  .map((item) => semanticCanonical(item))
  .filter(Boolean);

const alternativeMatches = (alternative, compactAnswer, sentences) => {
  const expected = semanticCanonical(alternative);
  if (!expected) return false;
  if (compactAnswer.includes(expected)) return true;

  // Short concepts and exact markers remain exact. Longer natural-language concepts
  // may match an equivalent local sentence, but only with high ordered coverage.
  if (expected.length < 6 || /\d/.test(expected)) return false;
  return sentences.some((sentence) => {
    if (sentence.length > Math.max(120, expected.length * 8)) return false;
    return lcsLength(expected, sentence) / expected.length >= 0.82;
  });
};

const scoreConcepts = (concepts, answer) => {
  if (!Array.isArray(concepts) || concepts.length === 0) {
    return { coverage: 1, matched: [], missing: [] };
  }
  const compactAnswer = semanticCanonical(answer);
  const sentences = sentenceCandidates(answer);
  const matched = [];
  const missing = [];
  for (const concept of concepts) {
    const alternatives = conceptAlternatives(concept);
    if (alternatives.some((alternative) => alternativeMatches(alternative, compactAnswer, sentences))) {
      matched.push(concept);
    } else {
      missing.push(concept);
    }
  }
  return {
    coverage: round4(matched.length / concepts.length),
    matched,
    missing,
  };
};

const scoreStructuredConcepts = (concepts, answer) => {
  if (!Array.isArray(concepts) || concepts.length === 0) return null;
  const weighted = concepts.map((concept) => ({
    id: String(concept.id || ''),
    alternatives: Array.isArray(concept.alternatives) ? concept.alternatives : [],
    weight: Number.isFinite(Number(concept.weight)) && Number(concept.weight) > 0 ? Number(concept.weight) : 1,
    required: concept.required !== false,
  }));
  const requiredItems = weighted.filter((item) => item.required);
  const totalWeight = requiredItems.reduce((sum, item) => sum + item.weight, 0) || 1;
  const compactAnswer = semanticCanonical(answer);
  const sentences = sentenceCandidates(answer);
  const matched = weighted.filter((item) => item.alternatives.some((alternative) => (
    alternativeMatches(alternative, compactAnswer, sentences)
  )));
  const matchedIds = new Set(matched.map((item) => item.id));
  return {
    coverage: round4(matched.filter((item) => item.required).reduce((sum, item) => sum + item.weight, 0) / totalWeight),
    matched: matched.map((item) => item.id),
    missing: weighted.filter((item) => item.required && !matchedIds.has(item.id)).map((item) => item.id),
  };
};

const versionPattern = /\b[A-Za-z]{1,12}(?:-[A-Za-z0-9]+)*-\d+(?:\.\d+)+(?:-[A-Za-z0-9]+)*\b/g;

const extractVersions = (value = '') => new Set(
  [...String(value).matchAll(versionPattern)].map((match) => match[0].toUpperCase())
);

const versionFamily = (version) => String(version).toUpperCase().replace(/\d+(?:\.\d+)+(?:-[A-Z0-9]+)*$/, '');

const removeVersions = (value = '') => String(value).replace(versionPattern, ' ');

const removeIdentifiers = (value = '') => String(value).replace(
  /\b(?:[A-Za-z][A-Za-z0-9]*(?:[-+][A-Za-z0-9.]+)+|[A-Za-z]+\d+[A-Za-z0-9]*)\b/g,
  ' '
);

const normalizeNumber = (raw) => {
  const percent = raw.endsWith('%');
  const number = Number(raw.replace(/,/g, '').replace(/%$/, ''));
  if (!Number.isFinite(number)) return null;
  return `${percent ? 'pct' : 'num'}:${Number(number.toFixed(8))}`;
};

const extractNumbers = (value = '') => {
  const clean = removeIdentifiers(removeVersions(stripCitations(value)));
  return new Set(
    [...clean.matchAll(/(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?%?/g)]
      .map((match) => normalizeNumber(match[0]))
      .filter(Boolean)
  );
};

const setDifference = (left, right) => [...left].filter((item) => !right.has(item));

const hasNumericConflict = (expectation, answer) => {
  const numericConcepts = (expectation.expectedKeywords || [])
    .flatMap(conceptAlternatives)
    .filter((item) => /^\s*(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?%?\s*$/.test(item));
  const critical = extractNumbers(numericConcepts.join(' '));
  if (critical.size === 0) return false;
  const actual = extractNumbers(answer);
  const allowed = extractNumbers(expectation.expectedAnswer || '');
  const missingCritical = setDifference(critical, actual);
  const unexpectedActual = setDifference(actual, allowed);
  return missingCritical.length > 0 && unexpectedActual.length > 0;
};

const hasVersionConflict = (expectation, answer) => {
  const critical = extractVersions((expectation.expectedKeywords || []).join(' '));
  if (critical.size === 0) return false;
  const actual = extractVersions(answer);
  const allowed = extractVersions(expectation.expectedAnswer || '');
  const missing = setDifference(critical, actual);
  const unexpected = setDifference(actual, allowed);
  return missing.some((expectedVersion) => (
    unexpected.some((actualVersion) => versionFamily(actualVersion) === versionFamily(expectedVersion))
  ));
};

const hasPolarityConflict = (expectation, answer) => {
  const negativePattern = /不一定|不自动|不等于|不代表|不证明|不说明|不构成|不建议|不是|不能|无法|不可以|不可|不得|不应|没有|不足|未曾|并未|未/g;
  const positivePattern = /可以|能够|等于|已经|批准|必须|应当|需要|确认|承认|优先|是/g;
  const clauses = (value) => stripCitations(value)
    .split(/[，,。！？!?；;\n]+/)
    .map((raw) => {
      const normalized = semanticCanonical(raw);
      const negative = new RegExp(negativePattern.source).test(normalized);
      const positive = new RegExp(positivePattern.source).test(normalized);
      const polarity = negative && !positive ? 'negative' : positive && !negative ? 'positive' : 'unknown';
      const content = normalized.replace(negativePattern, '').replace(positivePattern, '');
      return { polarity, content };
    })
    .filter((item) => item.polarity !== 'unknown' && item.content.length >= 4);

  const expectedClauses = clauses(expectation.expectedAnswer || '');
  const actualClauses = clauses(answer);
  return expectedClauses.some((expectedClause) => actualClauses.some((actualClause) => {
    if (expectedClause.polarity === actualClause.polarity) return false;
    const shorterLength = Math.min(expectedClause.content.length, actualClause.content.length);
    if (shorterLength < 4) return false;
    return lcsLength(expectedClause.content, actualClause.content) / shorterLength >= 0.75;
  }));
};

const normalizeSourceName = (value) => path.basename(String(value || '').replace(/\\/g, '/'))
  .normalize('NFC')
  .trim()
  .toLowerCase();

const sourceName = (source) => normalizeSourceName(
  source?.filename || source?.metadata?.filename || source?.file_name || ''
);

const scoreSourceRecall = (expectedSources, actualSources) => {
  if (!Array.isArray(expectedSources) || expectedSources.length === 0) return 1;
  const actualNames = new Set((actualSources || []).map(sourceName).filter(Boolean));
  const matches = expectedSources.filter((expected) => actualNames.has(normalizeSourceName(expected)));
  return round4(matches.length / expectedSources.length);
};

const scoreSourcePolicyRecall = (policy, actualSources) => {
  if (!policy) return null;
  const actualNames = new Set((actualSources || []).map(sourceName).filter(Boolean));
  const requiredAll = Array.isArray(policy.requiredAll) ? policy.requiredAll : [];
  const requiredAny = Array.isArray(policy.requiredAny) ? policy.requiredAny : [];
  const obligations = [
    ...requiredAll.map((filename) => [filename]),
    ...requiredAny.filter(Array.isArray),
  ];
  if (obligations.length === 0) return 1;
  const hits = obligations.filter((group) => group.some((filename) => actualNames.has(normalizeSourceName(filename)))).length;
  return round4(hits / obligations.length);
};

const hardFactResult = (hardFacts, answer) => {
  const compactAnswer = compactText(answer);
  const missing = [];
  const conflicts = [];
  for (const fact of Array.isArray(hardFacts) ? hardFacts : []) {
    const required = Array.isArray(fact.requiredAny) ? fact.requiredAny : [];
    const forbidden = Array.isArray(fact.forbiddenAny) ? fact.forbiddenAny : [];
    if (required.length > 0 && !required.some((item) => compactAnswer.includes(compactText(item)))) {
      missing.push(String(fact.id || 'unnamed_fact'));
    }
    if (forbidden.some((item) => compactAnswer.includes(compactText(item)))) {
      conflicts.push({ id: String(fact.id || 'unnamed_fact'), type: String(fact.type || 'fact') });
    }
  }
  return { missing, conflicts };
};

const citationNumbers = (answer) => [...String(answer || '').matchAll(/\[\s*Source\s+(\d+)\s*\]/gi)]
  .map((match) => Number(match[1]));

const sourceFilenameSet = (sources = []) => new Set(
  (Array.isArray(sources) ? sources : [])
    .map((source) => String(source?.filename || source?.fileName || '').toLowerCase())
    .filter(Boolean)
);

const sourceObligations = (expectation, sourcePolicy = {}) => {
  if (Array.isArray(sourcePolicy.requiredAll) || Array.isArray(sourcePolicy.requiredAny)) {
    return [
      ...(sourcePolicy.requiredAll || []).map((filename) => [String(filename)]),
      ...(sourcePolicy.requiredAny || []).map((alternatives) => (
        Array.isArray(alternatives) ? alternatives.map(String) : [String(alternatives)]
      )),
    ];
  }
  return (expectation?.expectedSources || []).map((filename) => [String(filename)]);
};

const obligationPresent = (obligation, filenames) => obligation.some((filename) => (
  filenames.has(String(filename).toLowerCase())
));

const citationFlowResult = (expectation, actual, sourcePolicy = {}) => {
  const obligations = sourceObligations(expectation, sourcePolicy);
  const traceAvailable = Object.hasOwn(actual || {}, 'promptSourceMap')
    && Object.hasOwn(actual || {}, 'modelCitedLabels')
    && Object.hasOwn(actual || {}, 'citationDecisions');
  const promptMap = Array.isArray(actual?.promptSourceMap) ? actual.promptSourceMap : [];
  const promptByNumber = new Map(promptMap.map((source) => [
    Number(source.source_number ?? source.sourceNumber),
    source,
  ]));
  const modelLabels = new Set((actual?.modelCitedLabels || []).map(Number).filter(Number.isFinite));
  const acceptedLabels = new Set((actual?.citationDecisions || [])
    .filter((decision) => decision?.supported === true)
    .map((decision) => Number(decision.source_number ?? decision.sourceNumber))
    .filter(Number.isFinite));
  const sourcesForLabels = (labels) => sourceFilenameSet(
    [...labels].map((label) => promptByNumber.get(label)).filter(Boolean)
  );
  const stages = {
    retrieved: sourceFilenameSet(actual?.retrievedSources),
    prompt: sourceFilenameSet(promptMap),
    modelCited: sourcesForLabels(modelLabels),
    verifierAccepted: sourcesForLabels(acceptedLabels),
    final: sourceFilenameSet(actual?.finalSources),
  };
  const counts = Object.fromEntries(Object.entries(stages).map(([stage, filenames]) => [
    stage,
    obligations.filter((obligation) => obligationPresent(obligation, filenames)).length,
  ]));
  const losses = {
    retrievalMiss: 0,
    contextOmission: 0,
    modelCitationOmission: 0,
    verifierRejection: 0,
    artifactLoss: 0,
  };
  for (const obligation of obligations) {
    if (!obligationPresent(obligation, stages.retrieved)) losses.retrievalMiss += 1;
    else if (traceAvailable && !obligationPresent(obligation, stages.prompt)) losses.contextOmission += 1;
    else if (traceAvailable && !obligationPresent(obligation, stages.modelCited)) losses.modelCitationOmission += 1;
    else if (traceAvailable && !obligationPresent(obligation, stages.verifierAccepted)) losses.verifierRejection += 1;
    else if (traceAvailable && !obligationPresent(obligation, stages.final)) losses.artifactLoss += 1;
  }
  return { obligations: obligations.length, stages: counts, losses };
};

const emptyCaseResult = (actual, reasons) => ({
  id: actual?.id || '',
  question: actual?.question || '',
  grade: 'unscorable',
  requiredConceptCoverage: 0,
  retrievedSourceRecall: 0,
  finalSourceRecall: 0,
  groundingStatus: actual?.answerGrounding?.status || 'not_applicable',
  groundingScore: Number(actual?.answerGrounding?.score || 0),
  numericConflict: false,
  versionConflict: false,
  polarityConflict: false,
  invalidCitationCount: 0,
  missingConcepts: [],
  reasons,
});

export function scoreAnswerCase(expectation, actual, contractCase = {}) {
  if (!expectation) return emptyCaseResult(actual, ['missing_expectation']);
  if (!actual) {
    return {
      ...emptyCaseResult({ id: expectation.id, question: expectation.question }, ['missing_actual_result']),
      grade: 'fail',
    };
  }

  const answer = String(actual.answer || '').trim();
  if (!answer) {
    return {
      ...emptyCaseResult(actual, ['empty_answer']),
      grade: 'fail',
    };
  }

  const hasStructuredConcepts = Array.isArray(contractCase.coreConcepts) && contractCase.coreConcepts.length > 0;
  const concept = scoreStructuredConcepts(contractCase.coreConcepts, answer)
    || scoreConcepts(expectation.expectedKeywords || [], answer);
  const retrievedSourceRecall = scoreSourcePolicyRecall(contractCase.sourcePolicy, actual.retrievedSources || [])
    ?? scoreSourceRecall(expectation.expectedSources || [], actual.retrievedSources || []);
  const finalSourceRecall = scoreSourcePolicyRecall(contractCase.sourcePolicy, actual.finalSources || [])
    ?? scoreSourceRecall(expectation.expectedSources || [], actual.finalSources || []);
  const hardFacts = hardFactResult(contractCase.hardFacts, answer);
  const numericConflict = hasNumericConflict(expectation, answer)
    || hardFacts.conflicts.some((item) => item.type === 'numeric');
  const versionConflict = hasVersionConflict(expectation, answer)
    || hardFacts.conflicts.some((item) => item.type === 'version');
  const structuredPolarity = (contractCase.hardFacts || [])
    .some((item) => ['polarity', 'boundary'].includes(item.type));
  const polarityConflict = (!structuredPolarity && hasPolarityConflict(expectation, answer))
    || hardFacts.conflicts.some((item) => ['polarity', 'boundary'].includes(item.type));
  const sourceCount = (actual.retrievedSources || []).length;
  const invalidCitationCount = citationNumbers(answer).filter((number) => number < 1 || number > sourceCount).length;
  const groundingStatus = String(actual.answerGrounding?.status || 'not_applicable');
  const groundingScore = Number(actual.answerGrounding?.score || 0);
  const citationFlow = citationFlowResult(expectation, actual, contractCase.sourcePolicy);

  const reasons = [];
  if (concept.missing.length > 0) reasons.push('missing_required_concept');
  if (hardFacts.missing.length > 0) reasons.push('missing_required_fact');
  if (retrievedSourceRecall < 1) reasons.push('retrieval_miss');
  if (finalSourceRecall < retrievedSourceRecall) reasons.push('citation_loss');
  if (citationFlow.losses.contextOmission > 0) reasons.push('context_omission');
  if (citationFlow.losses.modelCitationOmission > 0) reasons.push('model_citation_omission');
  if (citationFlow.losses.verifierRejection > 0) reasons.push('verifier_rejection');
  if (citationFlow.losses.artifactLoss > 0) reasons.push('artifact_loss');
  if (invalidCitationCount > 0) reasons.push('invalid_citation');
  if (groundingStatus === 'unsupported') reasons.push('unsupported_claim');
  if (numericConflict) reasons.push('numeric_conflict');
  if (versionConflict) reasons.push('version_conflict');
  if (polarityConflict) reasons.push('polarity_conflict');

  const hardConflict = hardFacts.conflicts.length > 0
    || numericConflict
    || versionConflict
    || polarityConflict
    || invalidCitationCount > 0;
  let grade;
  if (hardConflict || groundingStatus === 'unsupported') {
    grade = 'fail';
  } else if (
    concept.coverage >= 0.75
    && (!hasStructuredConcepts || concept.missing.length === 0)
    && hardFacts.missing.length === 0
    && finalSourceRecall >= 0.5
    && (!contractCase.requireCompleteSourcesForPass || finalSourceRecall === 1)
    && ['supported', 'partial'].includes(groundingStatus)
  ) {
    grade = 'pass';
  } else if (concept.coverage >= 0.4 && groundingStatus !== 'unsupported') {
    grade = 'partial';
  } else {
    grade = 'fail';
  }

  return {
    id: expectation.id,
    question: expectation.question,
    grade,
    requiredConceptCoverage: concept.coverage,
    retrievedSourceRecall,
    finalSourceRecall,
    groundingStatus,
    groundingScore: round4(groundingScore),
    numericConflict,
    versionConflict,
    polarityConflict,
    invalidCitationCount,
    citationFlow,
    missingConcepts: concept.missing,
    reasons: [...new Set(reasons)],
  };
}

const average = (values) => round4(values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0);

export function scoreAnswerRun(expectations, actualRun, contract = {}) {
  const contractCases = contract?.cases || {};
  const expectedById = new Map((expectations || []).map((item) => [item.id, item]));
  const actualById = new Map((actualRun?.results || []).map((item) => [item.id, item]));
  const orderedIds = [...new Set([
    ...(expectations || []).map((item) => item.id),
    ...(actualRun?.results || []).map((item) => item.id),
  ])];
  const cases = orderedIds.map((id) => scoreAnswerCase(expectedById.get(id), actualById.get(id), contractCases[id] || {}));
  const scorable = cases.filter((item) => item.grade !== 'unscorable');
  const count = (grade) => cases.filter((item) => item.grade === grade).length;
  const summary = {
    cases: cases.length,
    pass: count('pass'),
    partial: count('partial'),
    fail: count('fail'),
    unscorable: count('unscorable'),
    scorable: cases.length - count('unscorable'),
    requiredConceptCoverageMacro: average(scorable.map((item) => item.requiredConceptCoverage)),
    retrievedSourceRecallMacro: average(scorable.map((item) => item.retrievedSourceRecall)),
    finalSourceRecallMacro: average(scorable.map((item) => item.finalSourceRecall)),
    groundingSupported: scorable.filter((item) => item.groundingStatus === 'supported').length,
    groundingPartial: scorable.filter((item) => item.groundingStatus === 'partial').length,
    groundingUnsupported: scorable.filter((item) => item.groundingStatus === 'unsupported').length,
    numericConflicts: scorable.filter((item) => item.numericConflict).length,
    versionConflicts: scorable.filter((item) => item.versionConflict).length,
    polarityConflicts: scorable.filter((item) => item.polarityConflict).length,
    invalidCitations: scorable.reduce((sum, item) => sum + item.invalidCitationCount, 0),
    citationFlow: {
      obligations: scorable.reduce((sum, item) => sum + (item.citationFlow?.obligations || 0), 0),
      stages: {},
      losses: {},
    },
  };
  for (const stage of ['retrieved', 'prompt', 'modelCited', 'verifierAccepted', 'final']) {
    summary.citationFlow.stages[stage] = scorable.reduce(
      (sum, item) => sum + (item.citationFlow?.stages?.[stage] || 0),
      0
    );
  }
  for (const loss of ['retrievalMiss', 'contextOmission', 'modelCitationOmission', 'verifierRejection', 'artifactLoss']) {
    summary.citationFlow.losses[loss] = scorable.reduce(
      (sum, item) => sum + (item.citationFlow?.losses?.[loss] || 0),
      0
    );
  }
  summary.gates = {
    retrievedSourceRecall: summary.retrievedSourceRecallMacro >= 0.9,
    finalSourceRecall: summary.finalSourceRecallMacro >= 0.75,
    requiredConceptCoverage: summary.requiredConceptCoverageMacro >= 0.75,
    passingHardConflicts: cases
      .filter((item) => item.grade === 'pass')
      .every((item) => !item.numericConflict && !item.versionConflict && !item.polarityConflict),
    groundingUnsupported: summary.groundingUnsupported <= 4,
    failCount: summary.fail <= 5,
    passCount: summary.pass >= 30,
    allCasesScorable: summary.unscorable === 0 && summary.scorable === summary.cases,
  };
  summary.allGatesPassed = Object.values(summary.gates).every(Boolean);

  return {
    createdAt: new Date().toISOString(),
    scorerVersion: SCORER_VERSION,
    config: actualRun?.config || {},
    isolation: actualRun?.isolation || {},
    summary,
    cases,
  };
}

const fileHash = (filePath) => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');

const parseArgs = (argv) => {
  const args = { failOnGates: false, extractQuestions: false };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--actual') args.actual = argv[++index];
    else if (item === '--answers') args.answers = argv[++index];
    else if (item === '--output') args.output = argv[++index];
    else if (item === '--contract') args.contract = argv[++index];
    else if (item === '--fail-on-gates') args.failOnGates = true;
    else if (item === '--extract-questions') args.extractQuestions = true;
    else throw new Error(`Unknown argument: ${item}`);
  }
  if (!args.answers || !args.output || (!args.extractQuestions && !args.actual)) {
    throw new Error('Usage: node scripts/rag-answer-eval.mjs [--extract-questions | --actual <run.json>] --answers <answers.md> --output <report.json> [--contract <contract.json>] [--fail-on-gates]');
  }
  return args;
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const answerPath = path.resolve(args.answers);
  const outputPath = path.resolve(args.output);
  const expectations = parseAnswerTable(fs.readFileSync(answerPath, 'utf8'));
  if (expectations.length === 0) throw new Error('No evaluation cases found in answer table');

  if (args.extractQuestions) {
    const manifest = buildQuestionManifest(expectations);
    manifest.sourceSha256 = fileHash(answerPath);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify({ output: outputPath, cases: manifest.cases.length, expectationFields: 0 })}\n`);
    return;
  }

  const actualPath = path.resolve(args.actual);
  const actualRun = JSON.parse(fs.readFileSync(actualPath, 'utf8'));
  const contractPath = args.contract ? path.resolve(args.contract) : null;
  const contract = contractPath ? JSON.parse(fs.readFileSync(contractPath, 'utf8')) : {};
  const report = scoreAnswerRun(expectations, actualRun, contract);
  report.input = {
    actualSha256: fileHash(actualPath),
    answerPackSha256: fileHash(answerPath),
    contractSha256: contractPath ? fileHash(contractPath) : null,
    expectationCount: expectations.length,
  };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({ output: outputPath, summary: report.summary })}\n`);
  if (args.failOnGates && !report.summary.allGatesPassed) process.exitCode = 1;
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isCli) {
  main().catch((error) => {
    console.error('[rag-answer-eval]', toSafeError(error));
    process.exitCode = 1;
  });
}
