/** Read-only, native disclosure rows for declared capability workflows. */
import { createElement as h } from 'react'
import type { PackEntry } from './api.ts'
import { PACK_BOUNDARY_DESCRIPTION, packCostLabel } from '../shared/packs.ts'
import { T } from './view.ts'

/** Native details/summary preserves keyboard access without an execution action. */
export function packRow(pack: PackEntry): unknown {
  const guidance = pack.guidance
  const field = (label: string, text: string) => h('div', { style: { marginTop: '6px', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } },
    h('strong', {}, `${label}：`), text || '未提供')
  return h('details', { key: pack.id, style: { borderTop: `1px solid ${T.border}`, padding: '7px 0', color: T.text, fontSize: '12px' } },
    h('summary', { 'aria-label': `查看能力包：${pack.title}`, style: { cursor: 'pointer', overflowWrap: 'anywhere' } },
      h('span', { style: { color: pack.broken ? T.err : pack.enabled ? T.text : T.dim } }, pack.title),
      h('span', { style: { color: T.dim, fontSize: '11px', marginLeft: '8px' } },
        `${pack.enabled ? '已启用' : '已停用'} · ${pack.source === 'user' ? '你写的（含同 id 覆盖）' : '内置'} · ${packCostLabel(pack.cost_class)}`)),
    h('div', { style: { padding: '4px 8px 8px' } },
      pack.broken ? field('读不出来', pack.broken) : null,
      guidance ? h('div', {},
        field('工作流（声明）', guidance.workflow),
        field('工具推荐', guidance.tools.join('、')),
        field('证据要求', guidance.evidence),
        field('授权提示（非批准）', guidance.permissions),
        field('重试建议（非硬预算）', [guidance.budget.maxAttempts === undefined ? '未声明次数' : `${guidance.budget.maxAttempts} 次`, guidance.budget.note].filter(Boolean).join('；')),
        guidance.truncated ? field('指引已截短', `用 butler_pack {action:"show", id:"${pack.id}"} 查看完整声明。`) : null)
        : field('工作流', `此旧版总览未提供完整指引；用 butler_pack {action:"show", id:"${pack.id}"} 查看。`),
      field('适用边界', PACK_BOUNDARY_DESCRIPTION)))
}
