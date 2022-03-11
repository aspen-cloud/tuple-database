/*

	./node_modules/.bin/ts-node src/tools/compileSyncDatabase.ts

*/

import { execSync } from "child_process"
import * as fs from "fs"
import * as path from "path"

const rootPath = path.resolve(__dirname, "../..")
const inputPath = path.join(rootPath, "src/storage/AsyncTupleDatabase.ts")
const outputPath = path.join(rootPath, "src/storage/TupleDatabase.ts")

let contents = fs.readFileSync(inputPath, "utf8")

contents = contents.replace(/[Aa]sync/g, "")
contents = contents.replace(/await/g, "")
contents = contents.replace(/Promise<([^>]+)>/g, "$1")

contents = `
/*

This file is generated from AsyncTupleDatabase.ts

*/
${contents}
`

fs.writeFileSync(outputPath, contents)
execSync(
	path.join(rootPath, "node_modules/.bin/prettier") + " --write " + outputPath
)