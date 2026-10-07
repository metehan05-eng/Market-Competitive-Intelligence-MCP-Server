import type { PageSnapshot } from "../engine.js";
import type { ParseResult } from "../../types.js";
/** Parses blog/PR pages into published-article intelligence (content_pr). */
export declare function parseContent(snapshot: PageSnapshot): ParseResult;
/** Parses ProductHunt/Reddit/RSS-style feeds into trend intelligence (social_trends). */
export declare function parseSocial(snapshot: PageSnapshot): ParseResult;
