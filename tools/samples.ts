/** Download the sample clips into data/barnes-maze/ (see src/paradigms/barnes/samples.ts). */
import { ensureSampleClips, SAMPLE_DIR } from '../src/paradigms/barnes/samples';

await ensureSampleClips(SAMPLE_DIR, (line) => console.error(line));
console.error(`sample clips ready in ${SAMPLE_DIR}/`);
