/** Download the sample clips into data/barnes-maze/ (see src/paradigms/barnes/samples.ts). */
import { SAMPLE_DIR } from '../src/paradigms/barnes/samples';
import { ensureSampleClips } from '../src/paradigms/barnes/sampleFiles';

await ensureSampleClips(SAMPLE_DIR, (line) => console.error(line));
console.error(`sample clips ready in ${SAMPLE_DIR}/`);
