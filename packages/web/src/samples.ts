import embedded from '../../core/test/fixtures/embedded.yml?raw';
import withIncludes from '../../core/test/fixtures/with-includes.yml?raw';
import demoMain from '../../core/test/fixtures/inputs-demo/.gitlab-ci.yml?raw';
import demoBuild from '../../core/test/fixtures/inputs-demo/ci/build.yml?raw';
import demoHil from '../../core/test/fixtures/inputs-demo/ci/hil.yml?raw';
import demoRelease from '../../core/test/fixtures/inputs-demo/release.yml?raw';
import pcMain from '../../core/test/fixtures/parallel-child-demo/.gitlab-ci.yml?raw';
import pcChild from '../../core/test/fixtures/parallel-child-demo/ci/hil-child.yml?raw';
import pcGenerated from '../../core/test/fixtures/parallel-child-demo/hil-generated.yml?raw';

export const SAMPLES: { name: string; text: string; files?: Record<string, string> }[] = [
  { name: 'Embedded FW (demo)', text: embedded },
  { name: 'With includes (standalone mode)', text: withIncludes },
  {
    name: 'Inputs + includes (demo)', text: demoMain,
    files: { 'local:ci/build.yml': demoBuild, 'local:ci/hil.yml': demoHil, 'project:grp/ci-templates:release.yml': demoRelease },
  },
  {
    name: 'Parallel matrix + child pipelines (demo)', text: pcMain,
    files: { 'local:ci/hil-child.yml': pcChild, 'artifact:gen-hil-config:hil-generated.yml': pcGenerated },
  },
];
