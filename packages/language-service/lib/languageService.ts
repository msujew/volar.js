import type { CodeInformation, LinkedCodeMap, SourceMap } from '@volar/language-core';
import { isDefinitionEnabled, isImplementationEnabled, isTypeDefinitionEnabled, type Language } from '@volar/language-core';
import type * as ts from 'typescript';
import type * as vscode from 'vscode-languageserver-protocol';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import { LinkedCodeMapWithDocument, SourceMapWithDocuments } from './documents';
import * as autoInsert from './features/provideAutoInsertSnippet';
import * as callHierarchy from './features/provideCallHierarchyItems';
import * as codeActions from './features/provideCodeActions';
import * as codeLens from './features/provideCodeLenses';
import * as colorPresentations from './features/provideColorPresentations';
import * as completions from './features/provideCompletionItems';
import * as definition from './features/provideDefinition';
import * as diagnostics from './features/provideDiagnostics';
import * as documentColors from './features/provideDocumentColors';
import * as documentDrop from './features/provideDocumentDropEdits';
import * as format from './features/provideDocumentFormattingEdits';
import * as documentHighlight from './features/provideDocumentHighlights';
import * as documentLink from './features/provideDocumentLinks';
import * as semanticTokens from './features/provideDocumentSemanticTokens';
import * as documentSymbols from './features/provideDocumentSymbols';
import * as fileReferences from './features/provideFileReferences';
import * as fileRename from './features/provideFileRenameEdits';
import * as foldingRanges from './features/provideFoldingRanges';
import * as hover from './features/provideHover';
import * as inlayHints from './features/provideInlayHints';
import * as linkedEditing from './features/provideLinkedEditingRanges';
import * as references from './features/provideReferences';
import * as rename from './features/provideRenameEdits';
import * as renamePrepare from './features/provideRenameRange';
import * as selectionRanges from './features/provideSelectionRanges';
import * as signatureHelp from './features/provideSignatureHelp';
import * as workspaceSymbol from './features/provideWorkspaceSymbols';
import * as codeActionResolve from './features/resolveCodeAction';
import * as codeLensResolve from './features/resolveCodeLens';
import * as completionResolve from './features/resolveCompletionItem';
import * as documentLinkResolve from './features/resolveDocumentLink';
import * as inlayHintResolve from './features/resolveInlayHint';
import type { LanguageServicePlugin, LanguageServiceContext, LanguageServiceEnvironment } from './types';
import { UriMap, createUriMap } from './utils/uriMap';

export type LanguageService = ReturnType<typeof createLanguageService>;

export function createLanguageService(
	language: Language<URI>,
	plugins: LanguageServicePlugin[],
	env: LanguageServiceEnvironment
) {
	const documentVersions = createUriMap<number>();
	const map2DocMap = new WeakMap<SourceMap<CodeInformation>, SourceMapWithDocuments>();
	const mirrorMap2DocMirrorMap = new WeakMap<LinkedCodeMap, LinkedCodeMapWithDocument>();
	const snapshot2Doc = new WeakMap<ts.IScriptSnapshot, UriMap<TextDocument>>();
	const embeddedContentScheme = 'volar-embedded-content';
	const context: LanguageServiceContext = {
		language,
		documents: {
			get(uri, languageId, snapshot) {
				if (!snapshot2Doc.has(snapshot)) {
					snapshot2Doc.set(snapshot, createUriMap());
				}
				const map = snapshot2Doc.get(snapshot)!;
				if (!map.has(uri)) {
					const version = documentVersions.get(uri) ?? 0;
					documentVersions.set(uri, version + 1);
					map.set(uri, TextDocument.create(
						uri.toString(),
						languageId,
						version,
						snapshot.getText(0, snapshot.getLength())
					));
				}
				return map.get(uri)!;
			},
			getSourceMap(virtualCode) {
				const map = context.language.maps.get(virtualCode);
				let result = map2DocMap.get(map);
				if (!result) {
					const sourceScript = context.language.scripts.fromVirtualCode(virtualCode);
					const embeddedUri = context.encodeEmbeddedDocumentUri(sourceScript.id, virtualCode.id);
					map2DocMap.set(
						map,
						result = new SourceMapWithDocuments(
							this.get(sourceScript.id, sourceScript.languageId, sourceScript.snapshot),
							this.get(embeddedUri, virtualCode.languageId, virtualCode.snapshot),
							map,
							virtualCode,
						)
					);
				}
				return result;
			},
			getLinkedCodeMap(virtualCode, documentUri) {
				const map = context.language.linkedCodeMaps.get(virtualCode);
				if (map) {
					if (!mirrorMap2DocMirrorMap.has(map)) {
						const embeddedUri = context.encodeEmbeddedDocumentUri(documentUri, virtualCode.id);
						mirrorMap2DocMirrorMap.set(map, new LinkedCodeMapWithDocument(
							this.get(embeddedUri, virtualCode.languageId, virtualCode.snapshot),
							map,
							virtualCode,
						));
					}
					return mirrorMap2DocMirrorMap.get(map)!;
				}
			},
		},
		env,
		inject: (key, ...args) => {
			for (const plugin of context.plugins) {
				if (context.disabledServicePlugins.has(plugin[1])) {
					continue;
				}
				const provide = plugin[1].provide?.[key as any];
				if (provide) {
					return provide(...args as any);
				}
			}
		},
		plugins: [],
		commands: {
			rename: {
				create(uri, position) {
					return {
						title: '',
						command: 'editor.action.rename',
						arguments: [
							uri,
							position,
						],
					};
				},
				is(command) {
					return command.command === 'editor.action.rename';
				},
			},
			showReferences: {
				create(uri, position, locations) {
					return {
						title: locations.length === 1 ? '1 reference' : `${locations.length} references`,
						command: 'editor.action.showReferences',
						arguments: [
							uri,
							position,
							locations,
						],
					};
				},
				is(command) {
					return command.command === 'editor.action.showReferences';
				},
			},
			setSelection: {
				create(position: vscode.Position) {
					return {
						title: '',
						command: 'setSelection',
						arguments: [{
							selection: {
								selectionStartLineNumber: position.line + 1,
								positionLineNumber: position.line + 1,
								selectionStartColumn: position.character + 1,
								positionColumn: position.character + 1,
							},
						}],
					};
				},
				is(command) {
					return command.command === 'setSelection';
				},
			},
		},
		disabledEmbeddedDocumentUris: createUriMap(),
		disabledServicePlugins: new WeakSet(),
		decodeEmbeddedDocumentUri(maybeEmbeddedContentUri: URI) {
			if (maybeEmbeddedContentUri.scheme === embeddedContentScheme) {
				const embeddedCodeId = decodeURIComponent(maybeEmbeddedContentUri.authority);
				const documentUri = decodeURIComponent(maybeEmbeddedContentUri.path.substring(1));
				return [
					URI.parse(documentUri),
					embeddedCodeId,
				];
			}
		},
		encodeEmbeddedDocumentUri(documentUri: URI, embeddedContentId: string) {
			return URI.from({
				scheme: embeddedContentScheme,
				authority: encodeURIComponent(embeddedContentId),
				path: '/' + encodeURIComponent(documentUri.toString()),
			});
		},
	};
	const api = {
		getSemanticTokenLegend: () => {
			const tokenModifiers = plugins.map(plugin => plugin.capabilities.semanticTokensProvider?.legend?.tokenModifiers ?? []).flat();
			const tokenTypes = plugins.map(plugin => plugin.capabilities.semanticTokensProvider?.legend?.tokenTypes ?? []).flat();
			return {
				tokenModifiers: [...new Set(tokenModifiers)],
				tokenTypes: [...new Set(tokenTypes)],
			};
		},
		getTriggerCharacters: () => plugins.map(plugin => plugin.capabilities.completionProvider?.triggerCharacters ?? []).flat(),
		getAutoFormatTriggerCharacters: () => plugins.map(plugin => plugin.capabilities.documentOnTypeFormattingProvider?.triggerCharacters ?? []).flat(),
		getSignatureHelpTriggerCharacters: () => plugins.map(plugin => plugin.capabilities.signatureHelpProvider?.triggerCharacters ?? []).flat(),
		getSignatureHelpRetriggerCharacters: () => plugins.map(plugin => plugin.capabilities.signatureHelpProvider?.retriggerCharacters ?? []).flat(),

		format: format.register(context),
		getFoldingRanges: foldingRanges.register(context),
		getSelectionRanges: selectionRanges.register(context),
		findLinkedEditingRanges: linkedEditing.register(context),
		findDocumentSymbols: documentSymbols.register(context),
		findDocumentColors: documentColors.register(context),
		getColorPresentations: colorPresentations.register(context),

		doValidation: diagnostics.register(context),
		findReferences: references.register(context),
		findFileReferences: fileReferences.register(context),
		findDefinition: definition.register(context, 'provideDefinition', isDefinitionEnabled),
		findTypeDefinition: definition.register(context, 'provideTypeDefinition', isTypeDefinitionEnabled),
		findImplementations: definition.register(context, 'provideImplementation', isImplementationEnabled),
		prepareRename: renamePrepare.register(context),
		doRename: rename.register(context),
		getEditsForFileRename: fileRename.register(context),
		getSemanticTokens: semanticTokens.register(context),
		doHover: hover.register(context),
		doComplete: completions.register(context),
		doCodeActions: codeActions.register(context),
		doCodeActionResolve: codeActionResolve.register(context),
		doCompletionResolve: completionResolve.register(context),
		getSignatureHelp: signatureHelp.register(context),
		doCodeLens: codeLens.register(context),
		doCodeLensResolve: codeLensResolve.register(context),
		findDocumentHighlights: documentHighlight.register(context),
		findDocumentLinks: documentLink.register(context),
		doDocumentLinkResolve: documentLinkResolve.register(context),
		findWorkspaceSymbols: workspaceSymbol.register(context),
		doAutoInsert: autoInsert.register(context),
		doDocumentDrop: documentDrop.register(context),
		getInlayHints: inlayHints.register(context),
		doInlayHintResolve: inlayHintResolve.register(context),
		callHierarchy: callHierarchy.register(context),
		dispose: () => context.plugins.forEach(plugin => plugin[1].dispose?.()),
		context,
	};
	for (const plugin of plugins) {
		context.plugins.push([plugin, plugin.create(context, api)]);
	}
	return api;
}
