/*---------------------------------------------------------------------------------------------
* Copyright (c) 2020 Simon Waelti
* Licensed under the MIT License. See License.txt in the project root for license information.
*--------------------------------------------------------------------------------------------*/
'use strict';

import * as nodes from '../parser/macroNodes';

import { 
	TextDocument, 
	MacroFileProvider, 
} from '../macroLanguageTypes';
import { 
	LintConfiguration, 
	Rules,
	Rule 
} from './lintRules';

const _0 = '0'.charCodeAt(0);
const _9 = '9'.charCodeAt(0);
const _dot = '.'.charCodeAt(0);

const MAX_CONDITIONALS = 4;
const MAX_WHILE_DEPTH = 3;
const MAX_IF_DEPTH = 10;


export class LintVisitor implements nodes.IVisitor {

	static entries(macrofile: nodes.Node, document: TextDocument, fileProvider: MacroFileProvider, settings: LintConfiguration): nodes.IMarker[] {
		const visitor = new LintVisitor(fileProvider, settings);
		macrofile.acceptVisitor(visitor);
		visitor.completeValidations();
		return visitor.getEntries();
	}

	private declarations:Map<string,nodes.AbstractDeclaration> = new Map<string,nodes.AbstractDeclaration>()
	private sequenceList:FunctionMap<nodes.Function, nodes.Node> = new FunctionMap();
	private gotoList:FunctionMap<nodes.Function, nodes.GotoStatement> = new FunctionMap();
	private duplicateList: string[] = [];
	private imports: string[] = [];

	private rules: nodes.IMarker[] = [];
	private functionList = new Array<string>();

	private constructor(private fileProvider: MacroFileProvider, private settings: LintConfiguration) { }

	public getEntries(filter: number = (nodes.Level.Warning | nodes.Level.Error)): nodes.IMarker[] {
		return this.rules.filter(entry => {
			return (entry.getLevel() & filter) !== 0;
		});
	}

	public addEntry(node: nodes.Node, rule: Rule, details?: string): void {
		const entry = new nodes.Marker(node, rule, this.settings.getRule(rule), details);
		this.rules.push(entry);
	}

	private completeValidations() {

		// Check GOTO number occurrence
		for (const tuple of this.gotoList.elements) {
			const func = tuple[0];
			const gotoStatements = tuple[1];
			const sequences = this.sequenceList.get(func);
			for (const node of gotoStatements) {
				const jumpLabel = node.getLabel();
				if (jumpLabel) {
					let number = '';
					if (Number(jumpLabel.getText())) {
						number = jumpLabel.getText();
					}
					else if (jumpLabel instanceof nodes.Label){
						number = (<nodes.Label>jumpLabel).declaration?.getValue()?.getText();
					}
					else if (jumpLabel instanceof nodes.Variable) {
						const delc = (<nodes.Variable>jumpLabel).declaration;
						if (delc.valueType === nodes.ValueType.Numeric || delc.valueType === nodes.ValueType.Constant || delc.valueType === nodes.ValueType.Sequence) {
							number = (<nodes.Variable>jumpLabel).declaration?.getValue()?.getText();
						}
						else {
							continue;
						}
					}
					else {
						continue;
					}

					if (sequences && sequences.some(a => a.getText() === number)) {
						continue;
					}
					else {
						this.addEntry(jumpLabel, Rules.SeqNotFound);
					}
				}
			}
	
		}
	}

	public visitNode(node: nodes.Node): boolean {
		switch (node.type) {
			case nodes.NodeType.MacroFile:
				return this.visitGlobalScope(<nodes.MacroFile>node);
			case nodes.NodeType.Include:
				return this.visitIncludes(<nodes.Include>node);
			case nodes.NodeType.Symbol:
				return this.visitSymbols(<nodes.Symbol>node);
			case nodes.NodeType.Variable:
				return this.visitVariables(<nodes.Variable>node);
			case nodes.NodeType.Label:
				return this.visitLabels(<nodes.Label>node);
			case nodes.NodeType.VariableDef:
				return this.visitDeclarations(<nodes.VariableDeclaration>node, true);
			case nodes.NodeType.labelDef:
				return this.visitDeclarations(<nodes.LabelDeclaration>node, true);
			case nodes.NodeType.Function:
				return this.visitFunction(<nodes.Function>node);
			case nodes.NodeType.Statement:
				return this.visitStatement(<nodes.NcStatement>node);
			case nodes.NodeType.Goto:
				return this.visitGoto(<nodes.GotoStatement>node);
			case nodes.NodeType.SequenceNumber:
				return this.visitSequenceNumber(<nodes.SequenceNumber>node);		
			case nodes.NodeType.Assignment:
				return this.visitAssignment(<nodes.Assignment>node);
			case nodes.NodeType.If:
				return this.visitIfStatement(<nodes.IfStatement>node);	
			case nodes.NodeType.While:
				return this.visitWhileStatement(<nodes.WhileStatement>node);
		}
		return true;
	}

	private visitIncludes(node: nodes.Include) : boolean {
		let uri = node.getChild(0);
		if (!uri) {
			return false;
		}

		if (this.imports.indexOf(uri?.getText()) > -1){
			this.addEntry(node, Rules.DuplicateInclude);
		}
		else{
			this.imports.push(uri.getText());
			let declaration = this.fileProvider?.get(uri.getText());
			
			if (declaration) {
				(<nodes.Node>declaration?.macrofile).accept(candidate => {
					let found = false;
					if (candidate.type === nodes.NodeType.VariableDef || candidate.type === nodes.NodeType.labelDef) {
						const count = this.duplicateList.length;
						this.visitDeclarations(candidate, false);
						found = true;
					}
					return !found;
				});
			}
			else {
				this.addEntry(node, Rules.IncludeNotFound);
			}
		}
		return false;
	}

	private visitGlobalScope(node: nodes.Node) : boolean {
		return true;
	}

	private visitFunction(node: nodes.Function): boolean {

		let ident = node.getIdentifier();
		let number:string | undefined;
		if (ident) {
			if (ident instanceof nodes.Variable){
				let nr = (<nodes.Variable>ident).declaration?.getValue()?.getText();
				if (nr){
					number = nr;
				}
			}
			else {
				number = ident?.getText();
			}
			if (number && this.functionList.indexOf(number) === -1) {
				this.functionList.push(number);
			}
			else{
				this.addEntry(ident, Rules.DuplicateFunction);
			}
		}
		return true;
	}	

	private visitSymbols(node: nodes.Symbol) : boolean {

		// Check references
		if (!this.declarations.has(node.getText())) {
			if (!this.isNumeric(node.getText())) {
				this.addEntry(node, Rules.UnknownSymbol);
			}
		}
		return true;
	}

	private visitVariables(node: nodes.Variable) : boolean {
		if (this.duplicateList.indexOf(node.getName()) !== -1) {
			this.addEntry(node, Rules.DuplicateDeclaration);
		}

		if (node.declaration?.valueType === nodes.ValueType.Sequence) {
			const func = <nodes.Function>node.findAParent(nodes.NodeType.Function);
			const value = (<nodes.SequenceNumber>node.declaration.getValue())?.getNumber();
			if (value && func) {		
				this.addSequenceNumber(node, func, value);
			}
		}
		return true;
	}

	private visitLabels(node: nodes.Label) : boolean {
		const parentType = node.getParent().type;
		if (parentType === nodes.NodeType.Function 
			|| parentType === nodes.NodeType.Else 
			|| parentType === nodes.NodeType.Then 
			|| parentType === nodes.NodeType.While) {
			const func = <nodes.Function>node.findAParent(nodes.NodeType.Function);
			const value = node.declaration?.value;
			if (value && func) {		
				this.addSequenceNumber(node, func, value);
			}
		}
		return true;
	}

	private addSequenceNumber(node:nodes.Node, func:nodes.Function, value:nodes.Node) {
		const list = this.sequenceList.get(func);
		const duplicate = list?.some(a => {
			if (a.getText() === value.getText()) {
				if (a.type !== value.type){
					this.addEntry(node, Rules.DuplicateLabelSequence);
				}
				else {
					this.addEntry(node, Rules.DuplicateLabel);
				}
				return true;
			}
			return false;
		});
		if (!duplicate) {
			this.sequenceList.add(func, value);
		}
	}


	private visitGoto(node: nodes.GotoStatement) : boolean {
		const func = <nodes.Function>node.findAParent(nodes.NodeType.Function);
		this.gotoList.add(func, node);
		return true;
	}

	/**
	 * 
	 * @param node 
	 * @param local if true execute some checks only for the current file 
	 */
	private visitDeclarations(node: nodes.Node, local:boolean) : boolean {
		// scan local declarations
		let def = <nodes.AbstractDeclaration>node;
		let ident = def.getName();

		if (ident){
			if (this.declarations.has(ident)) {
				this.duplicateList.push(ident);
				if (local) {
					this.addEntry(def, Rules.DuplicateDeclaration);
				}
			}
			
			if (local){
				const value = def.getValue()?.getText();
				for (const element of this.declarations.values()){
					if ((def.valueType ===  nodes.ValueType.Address 
						|| def.valueType ===  nodes.ValueType.NcCode 
						|| def.valueType ===  nodes.ValueType.Numeric) 
						&& (def.type ===  element.type &&  element.getValue()?.getText() === value)) {
						this.addEntry(def, Rules.DuplicateAddress);
					}
				}
			}
			
			if (node.type === nodes.NodeType.VariableDef) {
				this.declarations.set(ident, <nodes.VariableDeclaration>node);
			}
			else if (node.type === nodes.NodeType.labelDef) {
				this.declarations.set(ident, <nodes.LabelDeclaration>node);
			}
		}
		return true;
	}

	private visitStatement(node: nodes.NcStatement): boolean {
		for (const statement of node.getChildren()) {
			if (!statement.findAParent(nodes.NodeType.VariableDef)) {
				if (statement.type === nodes.NodeType.Parameter || statement.type === nodes.NodeType.Code) {
					if (statement.getText().length <= 1){
						this.addEntry(statement, Rules.IncompleteParameter);
					}
				}
			}
		}
		return true;
	}

	private visitSequenceNumber(node: nodes.SequenceNumber): boolean {

		const number = node.getNumber();
		if (number) {
			const func = <nodes.Function>node.findAParent(nodes.NodeType.Function);
			const list = this.sequenceList.get(func);
			const duplicate = list?.some(a => {
				if (a.getText() === number.getText()) {
					if (a.type !== number.type){
						this.addEntry(number, Rules.DuplicateLabelSequence);
					}
					else {
						this.addEntry(number, Rules.DuplicateSequence);
					}
					return true;
				}
				return false;
			});
			if (!duplicate) {
				this.sequenceList.add(func, number);
			}
		}
		return true;
	}

	private visitAssignment(node: nodes.Assignment): boolean {
		if (node.getVariable() instanceof nodes.Variable){
			const variable = <nodes.Variable>node.getVariable();
			if (variable.declaration?.valueType === nodes.ValueType.Constant){
				this.addEntry(variable, Rules.AssignmentConstant);
			}
		}
		return true;
	}
	
	private visitIfStatement(node: nodes.IfStatement): boolean {
		/**
		 * Check the logic operators of a conitional expression.
		 * Operators (|| and && ) can not mixed up e.g. [1 EQ #var || 2 EQ #var && 3 EQ #var]
		 * Max number of statements  MAX_CONDITIONALS
		 */
		let conditional = node.getConditional();
		let count = 1;	
		if (conditional) {
			let first = conditional.logic?.getText();
			while (conditional?.getNext()) {
				if (++count > MAX_CONDITIONALS){
					this.addEntry(conditional, Rules.TooManyConditionals);
					break;
				}
				
				const op = conditional.getNext()?.logic;
				if (!op) {
					break;
				}
				if (op.getText() !== first) {
					this.addEntry(op, Rules.MixedConditionals);
				}
				conditional = conditional.getNext();
			}
		}

		// check level from in to out
		let level = 0;
		const path = nodes.getNodePath(node, node.offset);
		for (let i = path.length-1; i > -1; i--) {
			const element = path[i];
			if (element.type === nodes.NodeType.If) {
				++level;
				if (level > MAX_IF_DEPTH) {
					this.addEntry(node, Rules.NestingTooDeep);
					return false;
				}
			}
		}
		return true;
	}

	private visitWhileStatement(node: nodes.WhileStatement): boolean {

		let depth = 0;
		let doNumber:number = 0;
		// Check no logic operators allowed
		const conditional = node.getConditional();
		if (conditional && conditional.logic) {
			this.addEntry(conditional, Rules.WhileLogicOperator);
		}

		// Check DO END label/number agreement
		if (node.dolabel && node.endlabel) {
			if (node.dolabel?.getText() !== node.endlabel?.getText()) {
				this.addEntry(node.dolabel, Rules.DoEndNumberNotEqual);
				this.addEntry(node.endlabel, Rules.DoEndNumberNotEqual);
			}

			if (Number(node.dolabel.getText())) {
				doNumber = Number(node.dolabel.getText());
				if (doNumber && doNumber > MAX_WHILE_DEPTH) {
					this.addEntry(node.dolabel, Rules.DoEndNumberTooBig);
				}

				const endNumber = Number(node.endlabel.getText());
				if (endNumber && endNumber > MAX_WHILE_DEPTH) {
					this.addEntry(node.endlabel, Rules.DoEndNumberTooBig);
				}
			}
			else if (node.dolabel instanceof nodes.Label){
				doNumber = Number((<nodes.Label>node.dolabel).declaration?.getValue()?.getText());
				if (doNumber > MAX_WHILE_DEPTH) {
					this.addEntry(node.dolabel, Rules.DoEndNumberNotEqual);
					this.addEntry(node.endlabel, Rules.DoEndNumberNotEqual);
				}
			}
		}

		const path = nodes.getNodePath(node, node.offset);
		for (let i = path.length-1; i > -1; i--) {
			const element = path[i];
			if (element.type !== nodes.NodeType.While) {
				continue;
			}

			const child = <nodes.WhileStatement>element;
			
			// Check while depth
			if (depth >= MAX_WHILE_DEPTH) {
				this.addEntry(node, Rules.NestingTooDeep);
				return false;
			}

			// Check duplicate DO number
			if (depth > 0) {
				let childDoNumber = -1;
				if (child.dolabel instanceof nodes.Label) {
					childDoNumber = Number(child.dolabel.declaration?.getValue()?.getText());
				}
				else {
					childDoNumber = Number(child.dolabel?.getText());
				}
				if (doNumber === childDoNumber) {
					this.addEntry(child.dolabel!, Rules.DuplicateDoEndNumber);
				}
			}
			++depth;
		}
		return true;
	}

	private isNumeric(text:string) : boolean {
		let isNumber = (ch:number) => {
			return ch >= _0 && ch <= _9 || ch ===_dot;
		};
		let len = 0;
		for (; len < text.length; len++) {
			if (!isNumber(text.charCodeAt(len))){
				return false;
			}
		}
		return true; 
	}
}

class FunctionMap<T extends nodes.Node, V> {
	public elements:Map<T, V[]> = new Map<T, V[]>();
	public add(key:T, value:V) {
		if (!this.elements.has(key)) {
			this.elements.set(key, new Array<V>());
		}
		this.elements.get(key)?.push(value);
	}

	public get(key:T) : V[] | undefined {
		return this.elements.get(key);
	}
}
