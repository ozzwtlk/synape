import { describe, it, expect } from 'vitest';
import { classifyCompute } from '../src/compute.ts';

const bash = (command: string) => JSON.stringify({ command, description: 'x' });

describe('classifyCompute', () => {
  it('recognises programs across Claude and Codex tool shapes', () => {
    expect(classifyCompute('Bash', bash("python3 - <<'EOF'\nimport numpy\nEOF"))).toBe('Python');
    expect(classifyCompute('Bash', bash('OMP_NUM_THREADS=4 timeout 600 uv run python fit.py'))).toBe('Python');
    expect(classifyCompute('shell', "/usr/bin/bash -lc 'wolframscript -file s.wls'")).toBe('Wolfram');
    expect(classifyCompute('mcp__Wolfram__WolframLanguageEvaluator', '{"code":"1+1"}')).toBe('Wolfram');
    expect(classifyCompute('shell', "bash -lc 'cd MG5_aMC && ./bin/mg5_aMC run.mg5'")).toBe('MadGraph');
    expect(classifyCompute('Bash', bash('cd micromegas_6.1/MSSM && make main=main.c && ./main data.par'))).toBe('micrOMEGAs');
    expect(classifyCompute('shell', "/usr/bin/bash -lc 'bash output/micromegas/build.sh'")).toBe('micrOMEGAs');
  });
  it('ignores reading, searching and editing', () => {
    expect(classifyCompute('Bash', bash('ls -la && grep foo bar'))).toBeUndefined();
    expect(classifyCompute('shell', "/usr/bin/bash -lc 'cat micromegas/out.log; rg -n omega src'")).toBeUndefined();
    expect(classifyCompute('Read', '{"file_path":"/x.py"}')).toBeUndefined();
  });
});
