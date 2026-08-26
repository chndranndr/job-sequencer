import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import { containedPath } from "./documents.js";

const RelativeTemplatePath=z.string().min(1).refine(value=>!isAbsolute(value)&&!value.split(/[\\/]/).includes(".."),"Template paths must be relative and contained.");
export const TemplateMetadataSchema=z.object({cv:z.record(z.string().min(1),z.object({file:RelativeTemplatePath,tags:z.array(z.string().trim().min(1)).max(20)}).strict()),coverLetter:RelativeTemplatePath}).strict();
export type TemplateMetadata=z.infer<typeof TemplateMetadataSchema>;

export async function loadTemplateMetadata(projectRoot=process.cwd()){
  const templatesDir=resolve(projectRoot,"templates");
  const metadata=TemplateMetadataSchema.parse(JSON.parse(await readFile(containedPath(templatesDir,"templates.json"),"utf8")));
  for(const entry of [...Object.values(metadata.cv).map(value=>value.file),metadata.coverLetter]) await readFile(containedPath(templatesDir,entry),"utf8");
  return {templatesDir,metadata};
}

export function selectCvTemplate(metadata:TemplateMetadata,tags:string[]){
  const candidates=Object.entries(metadata.cv); if(!candidates.length)throw new Error("No CV templates are configured.");
  return candidates.sort((a,b)=>b[1].tags.filter(tag=>tags.includes(tag)).length-a[1].tags.filter(tag=>tags.includes(tag)).length)[0]![0];
}
