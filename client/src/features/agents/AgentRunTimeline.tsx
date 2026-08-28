import { useMemo, useState } from 'react';
import { CircleCheck, CircleX, GitBranch, Info, Loader2, ShieldAlert, Square, Wrench } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import api from '../../lib/api';
import type { AgentEvent } from './types';

interface AgentRunTimelineProps {
  runId: string;
  events: AgentEvent[];
  active: boolean;
}

type ApprovalDecision = NonNullable<AgentEvent['decision']>;

// `expired` is not a rejection: nobody declined the tool, the decision window
// simply closed. Keeping it distinct matches the `agent_approval_expired`
// error code the server now reports.
const APPROVAL_DECISION_LABELS: Record<ApprovalDecision, string> = {
  approved: 'chat.approvalApproved',
  rejected: 'chat.approvalRejected',
  expired: 'chat.approvalExpired',
};

const APPROVAL_DECISION_STYLES: Record<ApprovalDecision, string> = {
  approved: 'text-emerald-300',
  rejected: 'text-red-300',
  expired: 'text-amber-300',
};

export default function AgentRunTimeline({ runId, events, active }: AgentRunTimelineProps) {
  const { t } = useTranslation();
  const [decidingApprovalId, setDecidingApprovalId] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [locallyDecided, setLocallyDecided] = useState<Record<string, 'approved' | 'rejected'>>({});
  const resolvedApprovals = useMemo(() => new Map(
    events
      .filter((event) => event.type === 'approval.resolved' && event.approvalId)
      .map((event) => [event.approvalId!, event.decision]),
  ), [events]);

  const decide = async (approvalId: string, decision: 'approved' | 'rejected') => {
    setDecidingApprovalId(approvalId);
    try {
      await api.post(`/agent-runs/${runId}/approvals/${approvalId}`, { decision });
      setLocallyDecided((current) => ({ ...current, [approvalId]: decision }));
      toast.success(t(decision === 'approved' ? 'chat.approvalApproved' : 'chat.approvalRejected'));
    } catch {
      toast.error(t('chat.approvalFailed'));
    } finally {
      setDecidingApprovalId(null);
    }
  };

  const cancel = async () => {
    if (!active || cancelling) return;
    setCancelling(true);
    try {
      await api.post(`/agent-runs/${runId}/cancel`);
      toast.success(t('agents.runCancelled'));
    } catch {
      toast.error(t('agents.runCancelFailed'));
    } finally {
      setCancelling(false);
    }
  };

  return (
    <details className="mb-3 rounded-lg border border-border/60 bg-bg-base/70 px-3 py-2" open={active}>
      <summary className="cursor-pointer text-xs font-medium text-text-main">
        <span className="inline-flex items-center gap-2">
          {t('chat.agentTimeline')} · {runId.slice(0, 8)}
          {active && (
            <button
              type="button"
              onClick={(event) => {
                event.preventDefault();
                void cancel();
              }}
              disabled={cancelling}
              className="inline-flex items-center gap-1 rounded border border-red-500/30 px-1.5 py-0.5 text-red-300 hover:bg-red-500/10 disabled:opacity-50"
            >
              <Square className="h-3 w-3" />
              {cancelling ? t('common.saving') : t('agents.cancelRun')}
            </button>
          )}
        </span>
      </summary>
      <div className="mt-2 space-y-2">
        {events.map((event, index) => {
          const subagentFailed = event.type === 'subagent.completed' && event.subagentStatus !== 'succeeded';
          const failed = event.type === 'tool.failed'
            || event.type === 'run.failed'
            || event.type === 'run.cancelled'
            || subagentFailed;
          const completed = event.type === 'tool.completed'
            || event.type === 'run.completed'
            || (event.type === 'subagent.completed' && event.subagentStatus === 'succeeded');
          const approval = event.type === 'approval.required';
          // A decision note is bookkeeping, not progress: it gets a muted icon so it
          // does not read as another step in the tool loop.
          const decision = event.type.startsWith('decision.');
          const subagent = event.type.startsWith('subagent.');
          const EventIcon = approval
            ? ShieldAlert
            : failed
              ? CircleX
              : completed
                ? CircleCheck
                : decision
                  ? Info
                  : subagent
                    ? GitBranch
                    : event.type === 'tool.started' ? Wrench : Loader2;
          const approvalDecision = event.approvalId
            ? resolvedApprovals.get(event.approvalId) || locallyDecided[event.approvalId]
            : undefined;

          return (
            <div
              key={`${event.type}-${event.approvalId || event.subagentRunId || event.toolCallId || index}`}
              className={`flex items-start gap-2 text-xs text-text-muted ${subagent ? 'ml-4 border-l border-border/60 pl-2' : ''}`}
            >
              <EventIcon className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${failed ? 'text-red-400' : approval ? 'text-amber-400' : completed ? 'text-emerald-400' : decision ? 'text-text-muted' : 'text-primary'} ${event.type === 'run.started' && active ? 'animate-spin' : ''}`} />
              <div className="min-w-0 flex-1">
                <span className="text-text-main">{t(`chat.agentEvents.${event.type}`, { defaultValue: event.type })}</span>
                {event.tool && <span className="ml-2 break-all font-mono text-[11px]">{event.tool}</span>}
                {event.subagentRunId && (
                  <span className="ml-2 font-mono text-[11px]">{event.subagentRunId.slice(0, 8)}</span>
                )}
                {typeof event.durationMs === 'number' && <span className="ml-2">{event.durationMs}ms</span>}
                {/* The coded reason is what distinguishes "a tool failed" from
                    "the endpoint was not allowlisted". */}
                {event.error && (
                  <span className="ml-2 break-all font-mono text-[11px] text-red-400">{event.error}</span>
                )}
                {event.detail && <span className="ml-2 break-words">{event.detail}</span>}
                {approval && event.approvalId && (
                  <div className="mt-2 rounded-md border border-amber-500/20 bg-amber-500/5 p-2">
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <span className="rounded border border-amber-500/30 px-1.5 py-0.5 text-amber-300">
                        {t(`agents.riskLevels.${event.riskLevel || 'high'}`)}
                      </span>
                      {event.expiresAt && <span>{t('chat.approvalExpires', { time: new Date(event.expiresAt).toLocaleTimeString() })}</span>}
                    </div>
                    {event.arguments !== undefined && (
                      <pre className="mb-2 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded bg-bg-base p-2 font-mono text-[11px] text-text-muted">
                        {JSON.stringify(event.arguments, null, 2)}
                      </pre>
                    )}
                    {approvalDecision ? (
                      <p className={APPROVAL_DECISION_STYLES[approvalDecision]}>
                        {t(APPROVAL_DECISION_LABELS[approvalDecision])}
                      </p>
                    ) : (
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => void decide(event.approvalId!, 'approved')}
                          disabled={decidingApprovalId === event.approvalId}
                          className="rounded bg-emerald-600 px-2.5 py-1.5 text-white hover:bg-emerald-500 disabled:opacity-50"
                        >
                          {t('chat.approveTool')}
                        </button>
                        <button
                          type="button"
                          onClick={() => void decide(event.approvalId!, 'rejected')}
                          disabled={decidingApprovalId === event.approvalId}
                          className="rounded border border-red-500/30 px-2.5 py-1.5 text-red-300 hover:bg-red-500/10 disabled:opacity-50"
                        >
                          {t('chat.rejectTool')}
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </details>
  );
}
