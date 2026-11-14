import { useState } from 'react';
import { Search, RefreshCw, X, Plus } from 'lucide-react';
import type {
  CrmTicket,
  PriorityLevel,
  SentimentLabel,
  TicketFilters,
} from '../types/support';
import {
  buildSalesforceCasePayload,
  buildZendeskTicketPayload,
  filterTickets,
} from '../lib/triage';

interface TicketQueueViewProps {
  tickets: CrmTicket[];
  onUpdateTicket: (
    id: string,
    patch: Partial<Pick<CrmTicket, 'status' | 'priority' | 'tags'>>
  ) => Promise<void>;
  onSyncTicket: (id: string) => Promise<void>;
}

function priorityTextColor(priority: PriorityLevel): string {
  switch (priority) {
    case 'P1':
      return 'text-red-600 font-semibold';
    case 'P2':
      return 'text-amber-600 font-semibold';
    case 'P3':
      return 'text-blue-600 font-medium';
    case 'P4':
      return 'text-slate-600 font-medium';
  }
}

function sentimentTextColor(sentiment: SentimentLabel): string {
  switch (sentiment) {
    case 'Negative':
      return 'text-red-600';
    case 'Mixed':
      return 'text-amber-600';
    case 'Positive':
      return 'text-emerald-600';
    default:
      return 'text-slate-600';
  }
}

export function TicketQueueView({
  tickets,
  onUpdateTicket,
  onSyncTicket,
}: TicketQueueViewProps) {
  const [filters, setFilters] = useState<TicketFilters>({
    platform: 'all',
    priority: 'all',
    sentiment: 'all',
    search: '',
  });
  const [selectedTicketId, setSelectedTicketId] = useState<string | null>(null);
  const [newTagInput, setNewTagInput] = useState('');
  const [isSyncingId, setIsSyncingId] = useState<string | null>(null);

  const visibleTickets = filterTickets(tickets, filters);
  const selectedTicket = tickets.find((t) => t.id === selectedTicketId) ?? null;

  const resetFilters = () => {
    setFilters({ platform: 'all', priority: 'all', sentiment: 'all', search: '' });
  };

  const handleAddTag = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedTicket) return;
    const tag = newTagInput.trim().toLowerCase().replace(/\s+/g, '-');
    if (!tag) return;
    if (!selectedTicket.tags.includes(tag)) {
      await onUpdateTicket(selectedTicket.id, {
        tags: [...selectedTicket.tags, tag],
      });
    }
    setNewTagInput('');
  };

  const handleRemoveTag = async (tagToRemove: string) => {
    if (!selectedTicket) return;
    await onUpdateTicket(selectedTicket.id, {
      tags: selectedTicket.tags.filter((t) => t !== tagToRemove),
    });
  };

  const handleSync = async (ticketId: string) => {
    setIsSyncingId(ticketId);
    try {
      await onSyncTicket(ticketId);
    } finally {
      setIsSyncingId(null);
    }
  };

  return (
    <div className="space-y-5">
      {/* Filter Toolbar */}
      <div className="bg-white border border-slate-200/90 rounded-xl shadow-[0_1px_2px_rgba(15,23,42,0.04)] p-4 flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-3">
          {/* Platform segmented buttons */}
          <div
            role="group"
            aria-label="Filter by CRM platform"
            className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg"
          >
            {(['all', 'salesforce', 'zendesk'] as const).map((plat) => (
              <button
                key={plat}
                type="button"
                onClick={() => setFilters((f) => ({ ...f, platform: plat }))}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                  filters.platform === plat
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {plat === 'all' ? 'All CRMs' : plat === 'salesforce' ? 'Salesforce' : 'Zendesk'}
              </button>
            ))}
          </div>

          {/* Priority Select */}
          <div className="flex items-center gap-2">
            <label htmlFor="filter-priority" className="text-xs font-medium text-slate-500">
              Priority
            </label>
            <select
              id="filter-priority"
              value={filters.priority}
              onChange={(e) =>
                setFilters((f) => ({
                  ...f,
                  priority: e.target.value as TicketFilters['priority'],
                }))
              }
              className="px-2.5 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500/30"
            >
              <option value="all">All Priorities</option>
              <option value="P1">P1 Critical</option>
              <option value="P2">P2 High</option>
              <option value="P3">P3 Medium</option>
              <option value="P4">P4 Low</option>
            </select>
          </div>

          {/* Sentiment Select */}
          <div className="flex items-center gap-2">
            <label htmlFor="filter-sentiment" className="text-xs font-medium text-slate-500">
              Sentiment
            </label>
            <select
              id="filter-sentiment"
              value={filters.sentiment}
              onChange={(e) =>
                setFilters((f) => ({
                  ...f,
                  sentiment: e.target.value as TicketFilters['sentiment'],
                }))
              }
              className="px-2.5 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500/30"
            >
              <option value="all">All Sentiments</option>
              <option value="Negative">Negative</option>
              <option value="Mixed">Mixed</option>
              <option value="Neutral">Neutral</option>
              <option value="Positive">Positive</option>
            </select>
          </div>
        </div>

        {/* Search Input */}
        <div className="relative w-full sm:w-64">
          <Search className="h-3.5 w-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="search"
            aria-label="Search tickets by ID, customer, or tag"
            placeholder="Search ID, account, tag..."
            value={filters.search}
            onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))}
            className="w-full pl-8 pr-3 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg text-slate-900 placeholder:text-slate-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-600"
          />
        </div>
      </div>

      {/* High-density CRM Ticket Table */}
      <div className="bg-white border border-slate-200/90 rounded-xl shadow-[0_1px_2px_rgba(15,23,42,0.04)] overflow-hidden">
        {visibleTickets.length === 0 ? (
          <div className="py-14 px-6 text-center">
            <p className="text-sm font-medium text-slate-900">
              No CRM tickets match the active filters
            </p>
            <p className="mt-1 text-xs text-slate-500">
              Adjust your search terms or reset filters to view all Salesforce and Zendesk tickets.
            </p>
            <button
              type="button"
              onClick={resetFilters}
              className="mt-4 px-4 py-2 text-xs font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 transition-colors"
            >
              Reset Filters
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-500">
                  <th className="py-2.5 px-4 whitespace-nowrap">Ticket ID</th>
                  <th className="py-2.5 px-4 whitespace-nowrap">Platform</th>
                  <th className="py-2.5 px-4">Customer & Subject</th>
                  <th className="py-2.5 px-4 whitespace-nowrap">Sentiment</th>
                  <th className="py-2.5 px-4 whitespace-nowrap">Priority / SLA</th>
                  <th className="py-2.5 px-4">Auto-Tags</th>
                  <th className="py-2.5 px-4 text-right whitespace-nowrap">Latency</th>
                  <th className="py-2.5 px-4 whitespace-nowrap">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-xs">
                {visibleTickets.map((ticket) => (
                  <tr
                    key={ticket.id}
                    onClick={() => setSelectedTicketId(ticket.id)}
                    className={`cursor-pointer transition-colors hover:bg-slate-50 ${
                      selectedTicketId === ticket.id ? 'bg-blue-50/50' : ''
                    }`}
                  >
                    <td className="py-3 px-4 font-mono tabular-nums font-medium text-slate-900 whitespace-nowrap">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedTicketId(ticket.id);
                        }}
                        className="hover:text-blue-600 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:underline"
                      >
                        {ticket.externalId}
                      </button>
                    </td>
                    <td className="py-3 px-4 text-slate-700 whitespace-nowrap">
                      {ticket.platform === 'salesforce' ? 'Salesforce' : 'Zendesk'}
                    </td>
                    <td className="py-3 px-4 max-w-xs">
                      <div className="font-medium text-slate-900 truncate">{ticket.subject}</div>
                      <div className="text-slate-500 truncate mt-0.5">
                        {ticket.customerName} · {ticket.company}
                      </div>
                    </td>
                    <td className="py-3 px-4 whitespace-nowrap">
                      <span className={`font-medium ${sentimentTextColor(ticket.sentiment)}`}>
                        {ticket.sentiment}
                      </span>{' '}
                      <span className="font-mono tabular-nums text-slate-400">
                        ({ticket.sentimentScore.toFixed(2)})
                      </span>
                    </td>
                    <td className="py-3 px-4 whitespace-nowrap">
                      <span className={priorityTextColor(ticket.priority)}>
                        {ticket.priority}
                      </span>{' '}
                      <span className="text-slate-400 font-mono tabular-nums">
                        · {ticket.slaMinutes}m
                      </span>
                    </td>
                    <td className="py-3 px-4 max-w-[220px]">
                      <span className="font-mono text-slate-600 truncate block">
                        {ticket.tags.slice(0, 3).join(' · ')}
                        {ticket.tags.length > 3 ? ` (+${ticket.tags.length - 3})` : ''}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-700 whitespace-nowrap">
                      {ticket.avgLatencyMs} ms
                    </td>
                    <td className="py-3 px-4 whitespace-nowrap text-slate-700">
                      {ticket.status}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Ticket Detail & CRM Payload Inspector */}
      {selectedTicket && (
        <section
          aria-label={`Inspect ticket ${selectedTicket.externalId}`}
          className="bg-white border border-slate-200 rounded-lg p-6 space-y-5"
        >
          <div className="flex items-start justify-between gap-4 border-b border-slate-100 pb-4">
            <div>
              <div className="flex items-center gap-2 text-xs font-mono text-slate-500">
                <span className="font-semibold text-slate-900">{selectedTicket.externalId}</span>
                <span aria-hidden="true">·</span>
                <span>
                  {selectedTicket.platform === 'salesforce'
                    ? 'Salesforce Service Cloud'
                    : 'Zendesk Support'}
                </span>
                <span aria-hidden="true">·</span>
                <span>{selectedTicket.slaTier} SLA</span>
              </div>
              <h3 className="mt-1 text-lg font-semibold text-slate-900">
                {selectedTicket.subject}
              </h3>
              <p className="mt-0.5 text-xs text-slate-500">
                {selectedTicket.customerName} ({selectedTicket.customerEmail}) ·{' '}
                {selectedTicket.company}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => handleSync(selectedTicket.id)}
                disabled={isSyncingId === selectedTicket.id || selectedTicket.status === 'Resolved'}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
              >
                <RefreshCw
                  className={`h-3.5 w-3.5 ${
                    isSyncingId === selectedTicket.id ? 'animate-spin' : ''
                  }`}
                />
                Sync to {selectedTicket.platform === 'salesforce' ? 'Salesforce' : 'Zendesk'}
              </button>
              <button
                type="button"
                aria-label="Close ticket inspector"
                onClick={() => setSelectedTicketId(null)}
                className="p-1.5 text-slate-400 hover:text-slate-700 rounded-md hover:bg-slate-100 transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          {selectedTicket.status === 'Resolved' && (
            <div className="px-3.5 py-2 bg-slate-50 border border-slate-200 rounded-md text-xs text-slate-600">
              This ticket is <span className="font-semibold text-slate-900">Resolved</span> and locked for CRM audit compliance.
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="space-y-4">
              <div>
                <h4 className="text-xs font-medium text-slate-500 mb-1">NLU Summary</h4>
                <p className="text-sm text-slate-800 leading-relaxed">{selectedTicket.summary}</p>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label
                    htmlFor="detail-priority"
                    className="block text-xs font-medium text-slate-600 mb-1"
                  >
                    Priority Override
                  </label>
                  <select
                    id="detail-priority"
                    value={selectedTicket.priority}
                    disabled={selectedTicket.status === 'Resolved'}
                    onChange={(e) =>
                      onUpdateTicket(selectedTicket.id, {
                        priority: e.target.value as PriorityLevel,
                      })
                    }
                    className="w-full px-3 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-md text-slate-900 disabled:opacity-60"
                  >
                    <option value="P1">P1 — Critical / Urgent</option>
                    <option value="P2">P2 — High</option>
                    <option value="P3">P3 — Medium / Normal</option>
                    <option value="P4">P4 — Low</option>
                  </select>
                </div>
                <div>
                  <label
                    htmlFor="detail-status"
                    className="block text-xs font-medium text-slate-600 mb-1"
                  >
                    Workflow Status
                  </label>
                  <select
                    id="detail-status"
                    value={selectedTicket.status}
                    disabled={selectedTicket.status === 'Resolved'}
                    onChange={(e) =>
                      onUpdateTicket(selectedTicket.id, {
                        status: e.target.value as CrmTicket['status'],
                      })
                    }
                    className="w-full px-3 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-md text-slate-900 disabled:opacity-60"
                  >
                    <option value="New">New</option>
                    <option value="In Progress">In Progress</option>
                    <option value="Escalated">Escalated</option>
                    <option value="Resolved">Resolved</option>
                  </select>
                </div>
              </div>

              <div>
                <span className="block text-xs font-medium text-slate-600 mb-1.5">
                  Ticket Tags
                </span>
                <div className="flex flex-wrap items-center gap-2 text-xs font-mono text-slate-700">
                  {selectedTicket.tags.map((tag) => (
                    <span key={tag} className="inline-flex items-center gap-1.5 bg-slate-50 border border-slate-200 px-2 py-0.5 rounded-sm">
                      {tag}
                      {selectedTicket.status !== 'Resolved' && (
                        <button
                          type="button"
                          aria-label={`Remove tag ${tag}`}
                          onClick={() => handleRemoveTag(tag)}
                          className="text-slate-400 hover:text-red-600"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      )}
                    </span>
                  ))}
                </div>
                {selectedTicket.status !== 'Resolved' && (
                  <form onSubmit={handleAddTag} className="mt-2.5 flex items-center gap-2">
                    <input
                      type="text"
                      aria-label="Add custom CRM tag"
                      placeholder="Add tag (e.g. vip-escalation)"
                      value={newTagInput}
                      onChange={(e) => setNewTagInput(e.target.value)}
                      className="flex-1 px-2.5 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-md text-slate-900"
                    />
                    <button
                      type="submit"
                      className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      Add Tag
                    </button>
                  </form>
                )}
              </div>
            </div>

            <div>
              <h4 className="text-xs font-medium text-slate-500 mb-1.5">
                {selectedTicket.platform === 'salesforce'
                  ? 'Salesforce Case sObject Payload'
                  : 'Zendesk Ticket REST Payload'}
              </h4>
              <pre className="p-4 bg-slate-900 text-slate-100 rounded-md text-[11px] font-mono overflow-x-auto max-h-64">
                {JSON.stringify(
                  selectedTicket.platform === 'salesforce'
                    ? buildSalesforceCasePayload(selectedTicket)
                    : buildZendeskTicketPayload(selectedTicket),
                  null,
                  2
                )}
              </pre>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
