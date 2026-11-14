import { useState } from 'react';
import type { PriorityLevel, TriageRule } from '../types/support';

interface TriageRulesViewProps {
  rules: TriageRule[];
  onSaveRule: (id: string, patch: Partial<TriageRule>) => Promise<void>;
}

export function TriageRulesView({ rules, onSaveRule }: TriageRulesViewProps) {
  const [savingId, setSavingId] = useState<string | null>(null);
  const [savedBannerId, setSavedBannerId] = useState<string | null>(null);

  const handleUpdate = async (id: string, patch: Partial<TriageRule>) => {
    setSavingId(id);
    try {
      await onSaveRule(id, patch);
      setSavedBannerId(id);
      setTimeout(() => {
        setSavedBannerId((prev) => (prev === id ? null : prev));
      }, 2000);
    } finally {
      setSavingId(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="bg-white border border-slate-200/90 rounded-xl shadow-[0_1px_2px_rgba(15,23,42,0.04)] p-5">
        <h2 className="text-base font-semibold text-slate-900">
          Automated Priority Triage & CRM Tagging Rules
        </h2>
        <p className="mt-1 text-xs text-slate-500">
          Configure how real-time NLU intents, negative sentiment thresholds, and SLA tiers map to Salesforce Case priorities and Zendesk ticket urgency tags.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {rules.map((rule) => (
          <section
            key={rule.id}
            className="bg-white border border-slate-200/90 rounded-xl shadow-[0_1px_2px_rgba(15,23,42,0.04)] p-5 space-y-4"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-sm font-semibold text-slate-900">{rule.name}</h3>
                <p className="mt-1 text-xs text-slate-500 leading-relaxed">{rule.description}</p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={rule.enabled}
                aria-label={`Toggle rule ${rule.name}`}
                disabled={savingId === rule.id}
                onClick={() => handleUpdate(rule.id, { enabled: !rule.enabled })}
                className={`px-3 py-1.5 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 ${
                  rule.enabled
                    ? 'bg-blue-50 border-blue-200 text-blue-700'
                    : 'bg-slate-50 border-slate-200 text-slate-500'
                }`}
              >
                {rule.enabled ? 'Enabled' : 'Disabled'}
              </button>
            </div>

            <div className="grid grid-cols-3 gap-3 pt-3 border-t border-slate-100">
              <div>
                <label
                  htmlFor={`priority-${rule.id}`}
                  className="block text-xs font-medium text-slate-600 mb-1"
                >
                  Assigned Priority
                </label>
                <select
                  id={`priority-${rule.id}`}
                  value={rule.assignPriority}
                  onChange={(e) =>
                    handleUpdate(rule.id, {
                      assignPriority: e.target.value as PriorityLevel,
                    })
                  }
                  className="w-full px-2.5 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-md text-slate-900"
                >
                  <option value="P1">P1 · Critical / Urgent</option>
                  <option value="P2">P2 · High</option>
                  <option value="P3">P3 · Medium / Normal</option>
                  <option value="P4">P4 · Low</option>
                </select>
              </div>

              <div>
                <label
                  htmlFor={`sentiment-${rule.id}`}
                  className="block text-xs font-medium text-slate-600 mb-1"
                >
                  Max Sentiment
                </label>
                <input
                  id={`sentiment-${rule.id}`}
                  type="number"
                  step="0.1"
                  min="-1"
                  max="1"
                  value={rule.maxSentimentScore}
                  onChange={(e) =>
                    handleUpdate(rule.id, {
                      maxSentimentScore: Number(e.target.value),
                    })
                  }
                  className="w-full px-2.5 py-1.5 text-xs font-mono tabular-nums bg-slate-50 border border-slate-200 rounded-md text-slate-900"
                />
              </div>

              <div>
                <label
                  htmlFor={`sla-${rule.id}`}
                  className="block text-xs font-medium text-slate-600 mb-1"
                >
                  SLA Target (min)
                </label>
                <input
                  id={`sla-${rule.id}`}
                  type="number"
                  min="5"
                  step="5"
                  value={rule.slaMinutes}
                  onChange={(e) =>
                    handleUpdate(rule.id, {
                      slaMinutes: Number(e.target.value),
                    })
                  }
                  className="w-full px-2.5 py-1.5 text-xs font-mono tabular-nums bg-slate-50 border border-slate-200 rounded-md text-slate-900"
                />
              </div>
            </div>

            <div className="pt-3 border-t border-slate-100 space-y-2 text-xs">
              <div className="flex items-center justify-between gap-4">
                <span className="text-slate-500">Matched Intents</span>
                <span className="font-mono text-slate-800 truncate">
                  {rule.intents.join(' · ')}
                </span>
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="text-slate-500">Auto-Applied Tags</span>
                <span className="font-mono text-slate-800 truncate">
                  {rule.autoTags.join(' · ')}
                </span>
              </div>
              <div className="flex items-center justify-between pt-1">
                <label className="inline-flex items-center gap-2 text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={rule.escalateToTier2}
                    onChange={(e) =>
                      handleUpdate(rule.id, { escalateToTier2: e.target.checked })
                    }
                    className="rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                  />
                  Auto-escalate to Tier-2 Incident Bridge
                </label>
                {savedBannerId === rule.id && (
                  <span className="text-xs font-medium text-emerald-700">Rule saved</span>
                )}
              </div>
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
