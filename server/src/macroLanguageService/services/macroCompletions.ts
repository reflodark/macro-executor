/*---------------------------------------------------------------------------------------------
* Copyright (c) 2020 Simon Waelti
* Licensed under the MIT License. See License.txt in the project root for license information.
*--------------------------------------------------------------------------------------------*/
'use strict';

import * as nodes from '../parser/macroNodes';
import { Symbols} from '../parser/macroSymbolScope';
import {
	TextDocument,
	Position, 
	CompletionList, 
	CompletionItem, 
	CompletionItemKind, 
	Range, 
	MacroFileProvider,
	InsertTextFormat,
	TextEdit,
	LanguageSettings,
	functionSignatures,
	MarkupKind,
	CustomKeywords
} from '../macroLanguageTypes';
import { getComment } from '../parser/macroScanner';
import { SignatureHelp, ParameterInformation, SignatureInformation } from 'vscode-languageserver';


let macroStatementTypes:nodes.ValueType[] = [
	nodes.ValueType.Address, 
	nodes.ValueType.Constant, 
	nodes.ValueType.Variable, 
	nodes.ValueType.Numeric
];

let labelTypes:nodes.ValueType[] = [
	nodes.ValueType.Numeric,
	nodes.ValueType.Constant,
	nodes.ValueType.Variable,
	nodes.ValueType.String
];

let operators = [
	'&&',
	'||',
	'EQ',
	'NE',
	'LE',
	'GE',
	'LT',
	'GT',
	'AND',
	'OR',
	'XOR',
	'MOD',
];

let keys = [
	'@',
	'>',
	'$',
	'$INCLUDE',
	'$NOLIST',
	'$LIST',
	'%',
];

let keyWords = [
	'IF',
	'THEN',
	'GOTO',
	'ENDIF',
	'WHILE',
	'DO',
	'END'
];

enum Sort {
	Undefinded 	= ' ',
	Operators	= '1',
	KeyWords	= '2',
	Label		= '3',
	Constant 	= '4',
	Variable 	= '5',
	Value 		= '6',
	Address		= '7',
	Nc			= '8',
}

export class MacroCompletion {
	private position!: Position;
	private offset!: number;
	private currentWord!: string;
	private textDocument!: TextDocument;
	private macroFile!: nodes.MacroFile;
	private customKeywords:CustomKeywords[];
	private symbolContext!: Symbols;
	private defaultReplaceRange!: Range;
	private nodePath!: nodes.Node[];
	private inc : number = 10;

	constructor(private fileProvider: MacroFileProvider) {}

	protected getSymbolContext(): Symbols {
		if (!this.symbolContext) {

			// local symbols
			this.symbolContext = new Symbols(this.macroFile, this.textDocument.uri);

			// Included symbols 
			const uris = this.getIncludeUris(this.macroFile);
			const types = this.fileProvider?.getAll({uris:uris});
			for (const type of types) {
				const symbols = new Symbols(<nodes.Node>type.macrofile, type.document.uri);
				this.symbolContext.getScope().addChild(symbols.getScope());
			}
		}
		return this.symbolContext;
	}

	private getIncludeUris(macroFile: nodes.MacroFile) : string[] {
		const includes = <string[]>macroFile.getData(nodes.Data.Includes);
		if (includes) {
			return [].concat(includes);
		}
		return [];
	}

	public doComplete(document: TextDocument, position: Position, macroFile: nodes.MacroFile, settings: LanguageSettings): CompletionList {
		this.offset = document.offsetAt(position);
		this.position = position;
		this.currentWord = this.getCurrentWord(document, this.offset);
		this.defaultReplaceRange = Range.create(Position.create(this.position.line, this.position.character - this.currentWord.length), this.position);
		this.textDocument = document;
		this.macroFile = macroFile;
		this.customKeywords = settings.keywords.slice();

		this.inc = settings.sequence?.increment ? Number(settings.sequence?.increment) : 10;

		try {
			const result: CompletionList = { isIncomplete: false, items: [] };
			this.nodePath = nodes.getNodePath(this.macroFile, this.offset);

			for (let i = this. nodePath.length - 1; i >= 0; i--) {
				const node = this.nodePath[i];
				
				if (node.type === nodes.NodeType.Function) {
					this.getSymbolProposals(result, nodes.ReferenceType.Variable);
					this.getSymbolProposals(result, nodes.ReferenceType.Label);
					this.getKeyWordProposals(result);
					this.getSequenceNumberSnippet(node, result);
				}
				else if (node.type === nodes.NodeType.Variable) {
					this.getSymbolProposals(result, nodes.ReferenceType.Variable);
				}
				else if (node.type === nodes.NodeType.If) {
					this.getSymbolProposals(result, nodes.ReferenceType.Variable, macroStatementTypes);
					this.getSymbolProposals(result, nodes.ReferenceType.Label, labelTypes);
				}
				else if (node.type === nodes.NodeType.Then || node.type === nodes.NodeType.Else || node.type === nodes.NodeType.While) {
					this.getSymbolProposals(result, nodes.ReferenceType.Variable, macroStatementTypes);
					this.getSymbolProposals(result, nodes.ReferenceType.Label, labelTypes);
					this.getKeyWordProposals(result);
					this.getSequenceNumberSnippet(node, result);
				}
				else if (node.type === nodes.NodeType.Goto) {
					this.getSymbolProposals(result, nodes.ReferenceType.Label, labelTypes);
					this.getSymbolProposals(result, nodes.ReferenceType.Variable, labelTypes);
				}
				else if (node.type === nodes.NodeType.ConditionalExpression 
					|| node.type === nodes.NodeType.BinaryExpression 
					|| node.type === nodes.NodeType.Assignment) {
					this.getSymbolProposals(result, nodes.ReferenceType.Variable, macroStatementTypes);
					this.getSymbolProposals(result, nodes.ReferenceType.Label, labelTypes);
					this.getOperatorProposals(result);
				}
				else {
					continue;
				}
				if (result.items.length > 0 || this.offset > node.offset) {
					this.getCustomProposals(result);
					return result;
				}
			}
			this.getCompletionsForMacroFile(result);			
			return result;

		} 
		finally {
			this.position = null!;
			this.currentWord = null!;
			this.textDocument = null!;
			this.macroFile = null!;
			this.symbolContext = null!;
			this.defaultReplaceRange = null!;
			this.nodePath = null!;
			this.customKeywords = null!;
		}
	}

	private getSymbolProposals(result: CompletionList, referenceType: nodes.ReferenceType, valueTypes: nodes.ValueType[] | undefined = undefined): CompletionList {
		let types:nodes.ValueType[] | undefined = undefined;
		let kind:CompletionItemKind = CompletionItemKind.Variable; 

		if (this.currentWord === '#') {
			if (referenceType !== nodes.ReferenceType.Variable) {
				return result;
			}
			types = [nodes.ValueType.Numeric];
		}
		else {
			types = valueTypes;
		}
		let sort:Sort = Sort.Undefinded;
		const symbols = this.getSymbolContext().findSymbols(referenceType, types);
		let type = '';
		for (const context of symbols){
	
			for (const symbol of context.symbols) {
				if (referenceType === nodes.ReferenceType.Variable) {
					type = 'symbol';
					switch (symbol.valueType){
						case nodes.ValueType.Address:
							sort = Sort.Address;
							kind = CompletionItemKind.Interface;
							break;
						case nodes.ValueType.Constant:
							sort = Sort.Constant;
							kind = CompletionItemKind.Constant;
							break;
						case nodes.ValueType.Variable:
							sort = Sort.Value;
							kind = CompletionItemKind.Value;
							break;
						case nodes.ValueType.Numeric:
							sort = Sort.Variable;
							kind = CompletionItemKind.Variable;
							break;
						case nodes.ValueType.NcCode:
							sort = Sort.Nc;
							kind = CompletionItemKind.Event;
							break;
						case nodes.ValueType.Undefinded:
							sort = Sort.Variable;
							kind = CompletionItemKind.Variable;
							break;
						default:
							sort = Sort.Variable;
							kind = CompletionItemKind.Variable;
							break;
					}
				}
				else if (referenceType === nodes.ReferenceType.Label) {
					type = 'label';
					switch (symbol.valueType){
						case nodes.ValueType.Numeric:
							sort = Sort.Label;
							kind = CompletionItemKind.Constant;
							break;
						case nodes.ValueType.String:
							sort = Sort.Label;
							kind = CompletionItemKind.Text;
							break;
						default:
							sort = Sort.Label;
							kind = CompletionItemKind.Constant;
							break;
					}
				}

				const detail = symbol.node instanceof nodes.AbstractDeclaration ? this.getMarkedStringForDeclaration(type, <nodes.AbstractDeclaration>symbol.node) : '';
				const doc = this.popCustomKeywordDescription(symbol.name);
				const completionItem: CompletionItem = {
					label: symbol.name,
					detail:detail,
					documentation: {
						kind: MarkupKind.Markdown,
						value: doc
					},
					kind: kind,
					sortText: sort
				};
				result.items.push(completionItem);
			}
		}
		return result;
	}

	private popCustomKeywordDescription(text:string) : string {
		const custom = this.customKeywords.find(a => a.symbol === text);
		const index = this.customKeywords.indexOf(custom);
		if (index > -1) {
			this.customKeywords.splice(index, 1);
		}

		let doc = '';
		if (custom){
			if (custom.description instanceof Array) {
				doc = custom.description.join('\n\n');
			}
			else {
				doc = custom.description;
			}
		}
		return doc;
	}

	private getOperatorProposals(result: CompletionList): CompletionList {
		for (const operator of operators) {
			const completionItem: CompletionItem = {
				label: operator,
				kind: CompletionItemKind.Operator,
				sortText: Sort.Operators
			};
			result.items.push(completionItem);
		}
		return result;
	}

	private getKeyWordProposals(result: CompletionList): CompletionList {
		for (const keyWord of keyWords) {
			const completionItem: CompletionItem = {
				label: keyWord,
				kind: CompletionItemKind.Keyword,
				sortText: Sort.KeyWords
			};
			result.items.push(completionItem);
		}
		return result;
	}

	private getCustomProposals(result: CompletionList): CompletionList {
		for (const key of this.customKeywords) {
			let doc = '';
			if (key.description instanceof Array) {
				doc = key.description.join('\n\n');
			}
			else {
				doc = key.description;
			}
			result.items.push(
				{
					label: key.symbol, 
					kind: CompletionItemKind.Snippet,
					documentation: {
						kind:MarkupKind.Markdown,
						value:doc
					}
				});
		}
		return result;
	}

	private getSequenceNumberSnippet(node: nodes.Node, result: CompletionList): CompletionList {

		const func = <nodes.Function>node.findAParent(nodes.NodeType.Function);
		let seq = 0;
		if (func) {
			func.accept(candidate => {
				if (candidate.type === nodes.NodeType.SequenceNumber) {
					const nnode = (<nodes.SequenceNumber>candidate).getNumber();
					if (nnode) {
						const number = nnode.getText().toLocaleLowerCase().split('n').pop();
						seq = Math.max(seq, Number(number) + this.inc);
						return false;
					}
				}
				return true;
			});
		}

		const range = this.getCompletionRange(null);
		const item: CompletionItem = {
			label: 'N-Number',
			documentation: '',
			textEdit: TextEdit.replace(range, 'N${1:'+`${seq}`+'} $0'),
			insertTextFormat: InsertTextFormat.Snippet,
			kind: CompletionItemKind.Snippet,
			sortText: ' '
		};
		
		result.items.push(item);
		return result;
	}

	private getCompletionsForMacroFile(result: CompletionList): CompletionList {
		const node = this.macroFile.findFirstChildBeforeOffset(this.offset);
		for (const key of keys) {
			result.items.push({label: key, kind: CompletionItemKind.Keyword});
		}
		return result;
	}

	private getCurrentWord(document: TextDocument, offset: number): string {
		let i = offset - 1;
		const text = document.getText();
		while (i >= 0 && ' \t\n\r":{[()]},*>+'.indexOf(text.charAt(i)) === -1) {
			i--;
		}
		return text.substring(i + 1, offset);
	}

	private getCompletionRange(existingNode: nodes.Node | null) : Range {
		if (existingNode && existingNode.offset <= this.offset && this.offset <= existingNode.end) {
			const end = existingNode.end !== -1 ? this.textDocument.positionAt(existingNode.end) : this.position;
			const start = this.textDocument.positionAt(existingNode.offset);
			if (start.line === end.line) {
				return Range.create(start, end); // multi line edits are not allowed
			}
		}
		return this.defaultReplaceRange;
	}

	private getMarkedStringForDeclaration(type: string, node: nodes.AbstractDeclaration) : string {		
		const comment = getComment(node.offset, this.textDocument.getText()).trim();
		const name = node.getName();
		const address = node.getValue()?.getText();
		const valueType = node.valueType?.toString();
		
		
		let text:string[] = [`(${type}:${valueType}) ` + `@${name} `+` ${address}`];
		if (comment){
			text.push(`${comment}`);
		}
		return text.join('\n\n');
	}

	public doSignature(document: TextDocument, position: Position, macroFile: nodes.MacroFile, settings: LanguageSettings) : SignatureHelp | null{

		const node = nodes.getNodeAtOffset(macroFile, document.offsetAt(position));
		if (!node){
			return null;
		}

		const paramNode = node.findAParent(nodes.NodeType.FuncParam);
		const funcNode:nodes.Ffunc = <nodes.Ffunc>node.findAParent(nodes.NodeType.Ffunc);
		const ident  = funcNode.getIdentifier()?.getText()?.toLocaleLowerCase();
		const children = funcNode?.getChildren();
		if (!ident) {
			return null;
		}

		const signatureIndex = funcNode.getData('signature');
		let parameterIndex = 0;
		for (const element of children) {
			if (element.type === nodes.NodeType.FuncParam) {
				if (paramNode === element) {
					break;
				}
				++parameterIndex;
			}
		}
		
		const signatures = functionSignatures[ident];
		const information:SignatureInformation[] = [];
		for (let signature of signatures) {
			const parameters:ParameterInformation[] = [];
			let text = ident;
			let deliminator = '';
			let first = true;
			if (signature) {
				for (const element of signature.param) {
	
					if (element._bracket){
						deliminator = '';
						text += element._bracket;
					}
					else if (element._escape) {
						deliminator = '';
						text += element._escape;
					}
	
					if (element._param){

						// Space if the first part is a parameter 
						// e.g setvnvar[name] -> setvn var[name]
						if (first) {
							text += ' ';
						}

						for (const param of element._param) {
							if (signature.delimiter) {
								text += deliminator;
							}
							const key = Object.keys(param)[0];
							text +=  key;
							parameters.push( 
								{
									label:  key,
									documentation: param[key]
								});
							deliminator = signature.delimiter + ' ';
						}
					}
					first = false;
				}
			}
			information.push({
				label: text,
				documentation: signature.description,
				parameters: parameters
			});
		}

	
		return {
			activeParameter:parameterIndex,
			activeSignature:signatureIndex,
			signatures: information
		};
	}
}

