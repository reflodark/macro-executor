/*---------------------------------------------------------------------------------------------
* Copyright (c) 2020 Simon Waelti
* Licensed under the MIT License. See License.txt in the project root for license information.
*--------------------------------------------------------------------------------------------*/
'use strict';

import {
	DocumentHighlight, DocumentHighlightKind, DocumentLink, Location,
	Position, Range, SymbolInformation, SymbolKind, TextEdit,
	MacroCodeLensCommand, TextDocument, MacroFileProvider, 
	WorkspaceEdit, MacroCodeLensType, MacroFileInfo, 
	SRC_FILES, ALL_FILES
} from '../macroLanguageTypes';
import * as nodes from '../parser/macroNodes';
import { Symbols } from '../parser/macroSymbolScope';
import { CodeLens } from 'vscode-languageserver';

class FunctionMap {
	private elements:Map<string, Location[]> = new Map<string,Location[]>();
	public add(key:string, value:Location){
		if (!this.elements.has(key)){
			this.elements.set(key, new Array<Location>());
		}
		this.elements.get(key)?.push(value);
	}

	public get(key:string) : Location[] | undefined {
		return this.elements.get(key);
	}
}

type EditEntries = {
    [key:string]:TextEdit[];
}

export class MacroNavigation {

	constructor(private fileProvider: MacroFileProvider){}
    
	public findDefinition(document: TextDocument, position: Position, macroFile: nodes.MacroFile): Location | null {

		const includes = this.getIncludeUris(macroFile);
		includes.push(document.uri);
		const offset = document.offsetAt(position);
		let node = nodes.getNodeAtOffset(macroFile, offset);
		node = node.findAParent(nodes.NodeType.Symbol, nodes.NodeType.Label) ?? node;

		if (!node) {
			return null;
		}
    
		for (const uri of includes) {
			let type = this.fileProvider?.get(uri);
			if (!type) {
				continue;
			}

			const symbols = new Symbols(<nodes.MacroFile>type.macrofile);
			const symbol = symbols.findSymbolFromNode(node);
			if (!symbol) {
				continue;
			}
        
			return {
				uri: type.document.uri,
				range: this.getRange(symbol.node, type.document)
			};
		}
		return null;
	}
    
	public findReferences(document: TextDocument, position: Position, macroFile: nodes.MacroFile, implType:nodes.ReferenceType | undefined = undefined): Location[] {

		const offset = document.offsetAt(position);
		let node = nodes.getNodeAtOffset(macroFile, offset);
		node = node.findAParent(nodes.NodeType.Symbol, nodes.NodeType.Label) ?? node.findAParent(nodes.NodeType.Variable, nodes.NodeType.Code) ?? node;
    
		if (!node) {
			return [];
		}
        
		const includeUri = this.findIncludeUri(document, node, macroFile);
		if (!includeUri) {
			return [];
		}

		const origin = this.fileProvider.get(includeUri);
		const symbolContext = new Symbols(<nodes.MacroFile>origin.macrofile);

		let files:MacroFileInfo[] = [];
		switch (node.type) {
			case nodes.NodeType.Variable:
			case nodes.NodeType.Code:
				files = this.fileProvider.getAll({glob:ALL_FILES});
				break;
			case nodes.NodeType.Numeric:
				if (node.getParent()?.type === nodes.NodeType.Goto || node.getParent()?.type === nodes.NodeType.SequenceNumber) {
					files.push(origin); 
					break;
				}
				return [];
			case nodes.NodeType.Label:
			case nodes.NodeType.Symbol:
				if (!(origin.macrofile instanceof nodes.MacroFile)) {
					files = this.fileProvider.getAll({glob:SRC_FILES});
					files = files.filter(file => {
						const includes = this.getIncludeUris(<nodes.MacroFile>file.macrofile);
						if (includes.some(uri => uri === origin.document.uri)) {
							return true;
						}
					});
				}
				files.push(origin);
				break;
			default:
				return [];
		}
		return this.findReferencesInternal(files, node, symbolContext, implType);   
	}

	public findImplementations(document: TextDocument, position: Position, macroFile: nodes.MacroFile): Location[] {
		let node = nodes.getNodeAtOffset(macroFile, document.offsetAt(position));
		node = node.findAParent(nodes.NodeType.Symbol, nodes.NodeType.Label) ?? node;
		let referenceType:nodes.ReferenceType = undefined;

		switch (node.type) {
			case nodes.NodeType.Symbol:
				referenceType = nodes.ReferenceType.Program;
				break;
			case nodes.NodeType.Label:
				referenceType = nodes.ReferenceType.JumpLabel;
				break;
			case nodes.NodeType.Numeric:
				if (node.getParent()?.type === nodes.NodeType.Goto) {
					referenceType = nodes.ReferenceType.JumpLabel;
					break;
				}
			default:
				return [];
		}

		return this.findReferences(document, position, macroFile, referenceType);
	}

	public findDocumentLinks(document: TextDocument, macroFile: nodes.MacroFile): DocumentLink[] {
		const result: DocumentLink[] = [];
		macroFile.accept(candidate => {
			if (candidate.type === nodes.NodeType.Include) {
				const link = this.uriLiteralNodeToDocumentLink(document, candidate);
				if (link) {
					result.push(link);
				}
				return false;
			}
			return true;
		});
		return result;
	}

	public findDocumentSymbols(document: TextDocument, macroFile: nodes.MacroFile): SymbolInformation[] {
		const result: SymbolInformation[] = [];

		macroFile.accept((node) => {
			const entry: SymbolInformation = {
				name: null!,
				kind: SymbolKind.Class,
				location: null!, 
			};

			if (node.type === nodes.NodeType.SymbolDef) {
				entry.name = (<nodes.SymbolDefinition>node).getName();
				entry.kind = SymbolKind.Variable;
			} 
			else if (node.type === nodes.NodeType.LabelDef) {
				entry.name = (<nodes.LabelDefinition>node).getName();
				entry.kind = SymbolKind.Constant;
			} 
			else if (node.type === nodes.NodeType.BlockSkip) {
				entry.name = node.getText();
				entry.kind = SymbolKind.Field;
			} 
			else if (node.type === nodes.NodeType.Program) {
				const prog = (<nodes.Program>node);
				entry.kind = SymbolKind.Function;
				if (prog.identifier?.symbol) {
					entry.name = prog.identifier.getText() + ' (' + prog.identifier.getNonSymbolText() + ')';           
				}
				else {
					entry.name = `O${prog.getName()}`;
				}
			} 
			else if (node.type === nodes.NodeType.SequenceNumber) {
				if (node.symbol instanceof nodes.Label) {
					const label = <nodes.Label>node.symbol;
					if (node.parent?.type === nodes.NodeType.Program || node.parent?.type === nodes.NodeType.Goto) {
						if (label.valueType === nodes.NodeType.Numeric) {
							entry.name = label.getText();
							entry.kind = SymbolKind.Constant;
						} 
					}
				}
				else if (node.getChildren().length > 1) {
					if (node.getParent()?.type !== nodes.NodeType.BlockSkip) {
						entry.name = node.getText();
						entry.kind = SymbolKind.Field;
					}
				}
			}
			else if (node.type === nodes.NodeType.Statement && (node.symbol || node.getChildren().length > 1)) {
				if (node.getParent()?.type !== nodes.NodeType.SequenceNumber && node.getParent()?.type !== nodes.NodeType.BlockSkip) {
					entry.name = node.getText();
			
					if (node.getChild(0).type === nodes.NodeType.Code) {
						entry.kind = SymbolKind.Event;
					}
					else {
						entry.kind = SymbolKind.Property;
					}
				}
			}
			else if (node.type === nodes.NodeType.Goto) {
				entry.name = node.getText();
				entry.kind = SymbolKind.Event;
			}
			else if (node.type === nodes.NodeType.Fcmd) {
				entry.name = (<nodes.Fcmd>node).getIdentifier().getNonSymbolText();
				entry.kind = SymbolKind.Event;
			}
			else {

				if (node.symbol) {
					entry.location = this.createLocationForSymbol(document, node.symbol);
				}

				if (node.type === nodes.NodeType.Code) {
				
					entry.name = node.getNonSymbolText();
					entry.kind = SymbolKind.Event;
				}
				else if (node.type === nodes.NodeType.Parameter) {
					
					if (node.symbol && node.symbol.valueType === nodes.NodeType.Address) {
						if (node.symbol.attrib === nodes.ValueAttribute.Parameter) {
							entry.kind = SymbolKind.Property;
						}
						else if (node.symbol.attrib === nodes.ValueAttribute.GCode || node.symbol.attrib === nodes.ValueAttribute.MCode) {
							entry.kind = SymbolKind.Event;
						}
						else {
							entry.kind = SymbolKind.Interface;
						}
					}
					else {
						entry.kind = SymbolKind.Property;
					}
					entry.name = node.getNonSymbolText();
				}
			}

			if (entry.name) {   
				if (!entry.location) {
					entry.location = this.createLocation(document, node);
				}
				result.push(entry);
			}

			return true;
		});
		return result;
	}

	public findCodeLenses(document: TextDocument, macroFile: nodes.MacroFile): CodeLens[] {

		const codeLenses: CodeLens[] = [];
		const definitions:FunctionMap = new FunctionMap();

		// local search
		if (macroFile.type === nodes.NodeType.MacroFile) {

			macroFile.accept(candidate => {
				if (candidate.type === nodes.NodeType.SymbolDef || candidate.type === nodes.NodeType.LabelDef) {
					return false;
				}
				else if (candidate.type === nodes.NodeType.Symbol || candidate.type === nodes.NodeType.Label) {
					const node = (<nodes.Symbol>candidate);
					if (node) {
						definitions.add(node.getText(), {
							uri:document.uri,  
							range: this.getRange(node, document)
						});
					}
				}
				return true;
			});
		}
		// global search
		else {

			let types = this.fileProvider.getAll({glob:SRC_FILES});
			for (const type of types) {

				if (((<nodes.MacroFile>type.macrofile).type === nodes.NodeType.DefFile)) {
					continue;
				}

				if ((<nodes.MacroFile>type.macrofile).type === nodes.NodeType.MacroFile) {
					const includes = this.getIncludeUris(<nodes.MacroFile>type.macrofile);
					if (includes.filter(uri => uri === document.uri).length <= 0) {
						continue;
					}
				}

				(<nodes.MacroFile>type.macrofile).accept(candidate => {
					if (candidate.type === nodes.NodeType.SymbolDef || candidate.type === nodes.NodeType.LabelDef) {
						return false;
					}
					else if (candidate.type === nodes.NodeType.Symbol || candidate.type === nodes.NodeType.Label) {
						const node = (<nodes.Symbol>candidate);
						if (node) {
							definitions.add(node.getText(), {
								uri:type.document.uri,  
								range: this.getRange(node, type.document)
							});
						}
					}
					return true;
				});
			}
		}

		(<nodes.Node>macroFile).accept(candidate => {
			if (candidate.type === nodes.NodeType.SymbolDef || candidate.type === nodes.NodeType.LabelDef) {

				const node = (<nodes.AbstractDefinition>candidate).getIdentifier();
				if (node) {
					const value = definitions.get(node.getText()); 
					const count = value?.length;
					const c = count === undefined ? 0 : count;
					const t:MacroCodeLensType = {
						title: c + (c !== 1 ? ' references' : ' reference'),
						locations: value?value:[],
						type: MacroCodeLensCommand.References
					};
					codeLenses.push(
						{
							range: this.getRange(node, document), 
							data:t
						});
				}
				return false;
			}
			return true;
		});

		return codeLenses;
	}
    
	public doPrepareRename(document: TextDocument, position: Position, macroFile: nodes.MacroFile): Range | null {
		let node = nodes.getNodeAtOffset(macroFile, document.offsetAt(position));
		node = node.findAParent(nodes.NodeType.Symbol, nodes.NodeType.Label) 
			?? node.findAParent(nodes.NodeType.Variable, nodes.NodeType.Code, nodes.NodeType.SequenceNumber) 
			?? node;

		switch (node.type) {
			case nodes.NodeType.Variable:
			case nodes.NodeType.Code:
			case nodes.NodeType.Numeric:
			case nodes.NodeType.Label:
			case nodes.NodeType.Symbol:
				return this.getRange(node, document);
			case nodes.NodeType.SequenceNumber:
				return this.getRange((<nodes.SequenceNumber>node).getNumber(), document);
			default:
				return null;
		}
	}

	public doRename(document: TextDocument, position: Position, newName: string, macroFile: nodes.MacroFile): WorkspaceEdit {
		const locations = this.findReferences(document, position, macroFile);
		const edits:EditEntries = {};
		const allUris = locations.map(a => a.uri);
		const uniqueUris = allUris.filter((v,i) => allUris.indexOf(v) === i);

		for (const uri of uniqueUris) {
			const fileLocations = locations.filter(a => uri === a.uri);
			edits[uri] = fileLocations.map(h => TextEdit.replace(h.range, newName));
		}

		return {
			changes: edits
		};
	}

	private uriLiteralNodeToDocumentLink(document: TextDocument, uriLiteralNode: nodes.Node): DocumentLink | null {
		if (uriLiteralNode.getChildren().length === 0) {
			return null;
		}
		const uriStringNode = uriLiteralNode.getChild(0);
		return this.uriStringNodeToDocumentLink(document, uriStringNode);
	}
    
	private uriStringNodeToDocumentLink(document: TextDocument, uriStringNode: nodes.Node | null): DocumentLink | null {
		if (!uriStringNode) {
			return null;
		}
    
		let rawUri = uriStringNode.getText();
		const range = this.getRange(uriStringNode, document);
    
		if (range.start.line === range.end.line && range.start.character === range.end.character) {
			return null;
		}
		let target = this.fileProvider.resolveReference(rawUri, document.uri);
		return {
			range,
			target
		};
	}
    
	private createLocationForSymbol(document: TextDocument, node: nodes.Node) : Location {
		return Location.create(document.uri, Range.create(document.positionAt(node.offset), document.positionAt(node.offset)));
	}

	private createLocation(document: TextDocument, node: nodes.Node) : Location {
		return Location.create(document.uri, Range.create(document.positionAt(node.offset), document.positionAt(node.end)));
	}

	private getRange(node: nodes.Node, document: TextDocument): Range {
		return Range.create(document.positionAt(node.offset), document.positionAt(node.end));
	}
    
	private findReferencesInternal(files:MacroFileInfo[], node:nodes.Node, symbolContext:Symbols, implType:nodes.ReferenceType | undefined = undefined):Location[] {
		let locations:Location[] = [];

		for (const type of files) {
			const macroFile = <nodes.MacroFile>type.macrofile;

			// finding condition: name and reference type
			const symbol = symbolContext.findSymbolFromNode(node);  
			if (!symbol) {
				continue;
			}

			const highlights: DocumentHighlight[] = [];
			macroFile.accept(candidate => { 
				if (symbolContext.matchesSymbol(candidate, symbol)) {
					let s = <nodes.Symbol>candidate;
					if (s && s.referenceTypes && implType) {
						if (s.hasReferenceType(implType)) {
							highlights.push({
								kind: this.getHighlightKind(candidate),
								range: this.getRange(candidate, type.document)
							});
						}
					}
					else {
						highlights.push({
							kind: this.getHighlightKind(candidate),
							range: this.getRange(candidate, type.document)
						});
					}
					return false;
				}   
				return true;
			});

			const ret = highlights.map(h => {
				return {
					uri: type.document.uri,
					range: h.range
				};
			});
			locations = locations.concat(ret);
		}
		return locations;
	}

	private findIncludeUri(document: TextDocument, node: nodes.Node, macroFile: nodes.MacroFile): string | null {
		const includes = this.getIncludeUris(macroFile);
		includes.push(document.uri);
    
		for (const uri of includes) {
			let type = this.fileProvider?.get(uri);
			if (!type) {
				continue;
			}

			const symbols = new Symbols(<nodes.MacroFile>type.macrofile);
			const symbol = symbols.findSymbolFromNode(node);
			if (!symbol) {
				continue;
			}
			return type.document.uri;
		}
		return null;
	}

	private getIncludeUris(macroFile: nodes.MacroFile) : string[] {
		const includes = <string[]>macroFile.getData(nodes.Data.Includes);
		if (includes) {
			return [].concat(includes);
		}
		return [];
	}

	private getHighlightKind(node: nodes.Node): DocumentHighlightKind {
		return DocumentHighlightKind.Read;
	}
}
