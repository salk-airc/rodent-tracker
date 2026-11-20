import { TOOL_VERSION } from '../project/schema';
import { frameTime } from '../time';
import { holeNumber } from '../types';
import { parameterFingerprint, settingsFingerprint, type ExportInput } from './tables';
import { formatReviewValue, reviewMeasures } from './review';
import { resultSettings } from './tables';

type Exclusion = { readonly fileName: string; readonly reason: string };

/** Self-contained review report. All text is escaped; the file contains no scripts. */
export function reviewReportHtml(
  projectName: string,
  inputs: ReadonlyArray<ExportInput>,
  exclusions: ReadonlyArray<Exclusion> = [],
): string {
  const provisional = inputs.filter((input) => input.resultStatus === 'provisional').length;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(projectName)} | Barnes maze report</title>
<style>
body{margin:0;background:#fbfbfa;color:#2f3437;font:15px/1.6 'Helvetica Neue',Arial,sans-serif}
main{max-width:64rem;margin:auto;padding:3rem 1.5rem}h1{font-size:2rem;letter-spacing:-.03em;line-height:1.2}
h1,h2,h3,p{margin:0 0 1rem}h2{font-size:1.25rem}h3{font-size:1rem}section{padding:2rem 0;border-top:1px solid #eaeaea}
header{padding-bottom:2rem}.muted,caption{color:#5c5b56}.status{border-left:3px solid #956400;padding-left:.75rem}
table{width:100%;border-collapse:collapse;font-size:.9rem;margin-bottom:1.25rem}th,td{text-align:left;vertical-align:top;padding:.5rem}
th{border-bottom:1px solid #c9c7c0}td{border-bottom:1px solid #eaeaea}.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
caption{text-align:left;margin-bottom:.5rem}.scroll{overflow-x:auto}
code{overflow-wrap:anywhere;font-size:.8rem}pre{white-space:pre-wrap;overflow-wrap:anywhere}dl{display:grid;grid-template-columns:auto 1fr;gap:.25rem 1rem}dt{color:#5c5b56}dd{margin:0}
@media print{body{background:white}main{padding:0}h2,h3{break-after:avoid}tr{break-inside:avoid}.scroll{overflow:visible}.evidence{break-before:page}}
</style></head><body><main><header>
<p class="muted">Barnes maze analysis · Version ${escapeHtml(TOOL_VERSION)}</p>
<h1>${escapeHtml(projectName)}</h1>
<p>${inputs.length} analyzed recording${inputs.length === 1 ? '' : 's'}.</p>
${provisional ? `<p class="status">${provisional} provisional ${provisional === 1 ? 'analysis' : 'analyses'}. Review the listed assumptions before using these values for statistical analysis.</p>` : ''}
<p class="muted">A censored latency is a lower bound. Missing measurements are marked unavailable. Coverage describes the available tracking; visual review is still needed to assess accuracy.</p>
</header>${inputs.map(trialSection).join('')}
${exclusions.length ? `<section><h2>Excluded recordings</h2><ul>${exclusions.map((item) => `<li>${escapeHtml(item.fileName)}: ${escapeHtml(item.reason)}</li>`).join('')}</ul></section>` : ''}
<section class="evidence"><h2>Events and settings</h2>${inputs.map(trialEvidence).join('')}</section>
</main></body></html>`;
}

function trialSection(input: ExportInput): string {
  const measures = Object.values(reviewMeasures(input.measures, input.geometry));
  const startSec = frameTime(input.timebase, input.trialStartFrame);
  const strategy = input.strategyOverride?.strategy ?? input.measures.strategy.strategy;
  const target = input.geometry.targetHoleIndex;
  const warnings = [...new Set(input.warnings)];
  return `<section><h2>${escapeHtml(input.fileName)}</h2>
<p class="${input.resultStatus === 'provisional' ? 'status' : 'muted'}">${escapeHtml(input.resultStatus)}${input.provisionalReasons.length ? `: ${escapeHtml(input.provisionalReasons.join('; '))}` : ''}</p>
<dl>
<dt>Animal / group</dt><dd>${escapeHtml(input.meta.animalId || 'Not provided')} / ${escapeHtml(input.meta.group || 'Not provided')}</dd>
<dt>Day / trial</dt><dd>${input.meta.day ?? 'Not provided'} / ${input.meta.trial ?? 'Not provided'}</dd>
<dt>Platform diameter</dt><dd>${input.geometry.platformDiameterCm} cm (${escapeHtml(input.geometry.platformDiameterSource)})</dd>
<dt>Escape hole</dt><dd>${target === null ? 'Unavailable' : holeNumber(input.geometry, target)} (${escapeHtml(input.geometry.targetProvenance)})</dd>
<dt>Trial start</dt><dd>Frame ${input.trialStartFrame}, ${startSec.toFixed(3)} s (${escapeHtml(input.trialStartReason)})</dd>
</dl>
<table><caption>Measurements from this analysis</caption><thead><tr><th>Measure</th><th class="num">Value</th><th>Unit</th><th>Qualification</th></tr></thead><tbody>
${measures.map((m) => `<tr><td>${escapeHtml(m.label)}</td><td class="num">${escapeHtml(formatReviewValue(m))}</td><td>${escapeHtml(m.unit)}</td><td>${escapeHtml([m.qualifier, 'provenance' in m && m.provenance === 'manual' ? 'Human edit' : ''].filter(Boolean).join('; '))}</td></tr>`).join('')}
</tbody></table>
<h3>Search strategy: ${escapeHtml(strategy)}</h3>
<p>${escapeHtml(input.strategyOverride?.reason ?? input.measures.strategy.notes)}</p>
<p class="muted">Automatic label: ${escapeHtml(input.measures.strategy.strategy)}. Rule: ${escapeHtml(input.measures.strategy.rule)}.</p>
<h3>Tracking review</h3>
<p>${input.measures.quality.manuallyEditedFrames} edited frame${input.measures.quality.manuallyEditedFrames === 1 ? '' : 's'}. ${input.gaps.length} tracking gap${input.gaps.length === 1 ? '' : 's'}.</p>
${warnings.length ? `<ul>${warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join('')}</ul>` : '<p>No detector warnings. Check the overlays against the recording.</p>'}
${input.gaps.length ? `<ul>${input.gaps.map((gap) => `<li>Frames ${gap.startFrame}–${gap.endFrame}: ${escapeHtml(gap.explanation)}</li>`).join('')}</ul>` : ''}
</section>`;
}

function trialEvidence(input: ExportInput): string {
  const events = [...input.events].sort((a, b) => a.startFrame - b.startFrame);
  const startSec = frameTime(input.timebase, input.trialStartFrame);
  return `<section><h3>${escapeHtml(input.fileName)} · ${events.length} events</h3>
<div class="scroll"><table><thead><tr><th>Event</th><th class="num">Hole</th><th class="num">Seconds from start</th><th class="num">Frame</th><th>Evidence</th></tr></thead><tbody>
${events.map((event) => `<tr><td>${event.type === 'entry' ? 'Entry' : 'Visit'}</td><td class="num">${holeNumber(input.geometry, event.holeIndex)}${event.isTarget ? ' (target)' : ''}</td><td class="num">${(frameTime(input.timebase, event.startFrame) - startSec).toFixed(3)}</td><td class="num">${event.startFrame}</td><td>${escapeHtml(event.evidence)}</td></tr>`).join('')}
</tbody></table></div>
<h3>Settings and provenance</h3>
<p>Tracking source: ${escapeHtml(input.trackingSource)}. Observation version: ${escapeHtml(input.observationToolVersion ?? 'Unavailable')}. Analyzed: ${escapeHtml(input.analyzedAt ?? 'Not recorded')}.</p>
<p>Parameter fingerprint: <code>${escapeHtml(parameterFingerprint(input.params))}</code><br>Result fingerprint: <code>${escapeHtml(settingsFingerprint(input.params, resultSettings(input)))}</code></p>
${input.sourceSha256 ? `<p>Source video SHA-256: <code>${escapeHtml(input.sourceSha256)}</code></p>` : ''}
${input.protocol ? `<h3>Lab protocol: ${escapeHtml(input.protocol.name)}, revision ${escapeHtml(input.protocol.revision)}</h3><p>${parameterFingerprint(input.params) === parameterFingerprint(input.protocol.params) ? 'Settings match the protocol.' : 'Settings were changed after applying the protocol.'} The protocol baseline is retained below.</p><pre><code>${escapeHtml(JSON.stringify(input.protocol.params, null, 2))}</code></pre>` : ''}
<pre><code>${escapeHtml(JSON.stringify(input.params, null, 2))}</code></pre>
</section>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!);
}
