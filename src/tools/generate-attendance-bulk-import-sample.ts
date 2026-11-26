import * as fs from 'fs';
import * as path from 'path';

import {
  ATTENDANCE_BULK_IMPORT_SAMPLE_FILENAME,
  buildAttendanceBulkImportSampleBuffer,
} from '../utils/attendance-bulk-import-template.utils';

async function main(): Promise<void> {
  const samplesDir = path.resolve(process.cwd(), 'samples');
  const outputPath = path.join(samplesDir, ATTENDANCE_BULK_IMPORT_SAMPLE_FILENAME);

  fs.mkdirSync(samplesDir, { recursive: true });

  const buffer = await buildAttendanceBulkImportSampleBuffer();
  fs.writeFileSync(outputPath, buffer);

  console.log(`Wrote ${outputPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
