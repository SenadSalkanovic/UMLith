import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const version='1.2026.8';
const checksum='0f77e5f769836b3dee340e207fe497c3e4c43e973d559e3c306915da9c32e34c';
const file=new URL(`../.tools/plantuml-${version}.jar`,import.meta.url);
const valid=data=>createHash('sha256').update(data).digest('hex')===checksum;
try { if(valid(await readFile(file))) { console.log(`PlantUML ${version} is ready.`); process.exit(0); } } catch(error) { if(error.code!=='ENOENT')throw error; }
const response=await fetch(`https://repo.maven.apache.org/maven2/net/sourceforge/plantuml/plantuml/${version}/plantuml-${version}.jar`,{signal:AbortSignal.timeout(60000)});
if(!response.ok)throw new Error('PlantUML download failed: '+response.status);
const data=Buffer.from(await response.arrayBuffer());
if(!valid(data))throw new Error('PlantUML checksum mismatch; nothing installed.');
await mkdir(new URL('../.tools/',import.meta.url),{recursive:true});
const temporary=new URL(file.href+'.download');
await writeFile(temporary,data);await rename(temporary,file);
console.log(`Installed local PlantUML ${version}. Java 11+ is required.`);
