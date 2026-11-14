import embedded from '../../core/test/fixtures/embedded.yml?raw';
import realtestRepaired from '../../core/test/fixtures/realtest-repaired.yml?raw';
import withIncludes from '../../core/test/fixtures/with-includes.yml?raw';
import realtestOriginal from '../../../realtest/.gitlab-ci.yml?raw';

export const SAMPLES: { name: string; text: string }[] = [
  { name: 'Embedded FW (demo)', text: embedded },
  { name: 'realtest (repaired structure)', text: realtestRepaired },
  { name: 'realtest (original file)', text: realtestOriginal },
  { name: 'With includes (standalone mode)', text: withIncludes },
];
