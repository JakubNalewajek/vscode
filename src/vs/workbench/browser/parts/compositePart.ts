/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'vs/css!./media/compositepart';
import * as nls from 'vs/nls';
import { defaultGenerator } from 'vs/base/common/idGenerator';
import { IDisposable, dispose, DisposableStore, MutableDisposable } from 'vs/base/common/lifecycle';
import * as strings from 'vs/base/common/strings';
import { Emitter } from 'vs/base/common/event';
import * as errors from 'vs/base/common/errors';
import { ToolBar } from 'vs/base/browser/ui/toolbar/toolbar';
import { IActionViewItem, ActionsOrientation } from 'vs/base/browser/ui/actionbar/actionbar';
import { ProgressBar } from 'vs/base/browser/ui/progressbar/progressbar';
import { prepareActions } from 'vs/workbench/browser/actions';
import { IAction, WBActionExecutedEvent, WBActionExecutedClassification } from 'vs/base/common/actions';
import { Part, IPartOptions } from 'vs/workbench/browser/part';
import { Composite, CompositeRegistry } from 'vs/workbench/browser/composite';
import { IComposite } from 'vs/workbench/common/composite';
import { CompositeProgressIndicator } from 'vs/workbench/services/progress/browser/progressIndicator';
import { IWorkbenchLayoutService } from 'vs/workbench/services/layout/browser/layoutService';
import { IStorageService, StorageScope } from 'vs/platform/storage/common/storage';
import { IContextMenuService } from 'vs/platform/contextview/browser/contextView';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { IProgressIndicator } from 'vs/platform/progress/common/progress';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { IKeybindingService } from 'vs/platform/keybinding/common/keybinding';
import { IThemeService } from 'vs/platform/theme/common/themeService';
import { attachProgressBarStyler } from 'vs/platform/theme/common/styler';
import { INotificationService } from 'vs/platform/notification/common/notification';
import { Dimension, append, $, addClass, hide, show, addClasses } from 'vs/base/browser/dom';
import { AnchorAlignment } from 'vs/base/browser/ui/contextview/contextview';
import { withNullAsUndefined } from 'vs/base/common/types';

export interface ICompositeTitleLabel {

	/**
	 * Asks to update the title for the composite with the given ID.
	 */
	updateTitle(id: string, title: string, keybinding?: string): void;

	/**
	 * Called when theming information changes.
	 */
	updateStyles(): void;
}

interface CompositeItem {
	composite: Composite;
	disposable: IDisposable;
	progress: IProgressIndicator;
}

export abstract class CompositePart<T extends Composite> extends Part {

	protected readonly onDidCompositeOpen = this._register(new Emitter<{ composite: IComposite, focus: boolean }>());
	protected readonly onDidCompositeClose = this._register(new Emitter<IComposite>());

	protected toolBar: ToolBar;

	private mapCompositeToCompositeContainer = new Map<string, HTMLElement>();
	private mapActionsBindingToComposite = new Map<string, () => void>();
	private activeComposite: Composite | null;
	private lastActiveCompositeId: string;
	private instantiatedCompositeItems: Map<string, CompositeItem>;
	private titleLabel: ICompositeTitleLabel;
	private progressBar: ProgressBar;
	private contentAreaSize: Dimension;
	private readonly telemetryActionsListener = this._register(new MutableDisposable());
	private currentCompositeOpenToken: string;

	constructor(
		private notificationService: INotificationService,
		protected storageService: IStorageService,
		private telemetryService: ITelemetryService,
		protected contextMenuService: IContextMenuService,
		protected layoutService: IWorkbenchLayoutService,
		protected keybindingService: IKeybindingService,
		protected instantiationService: IInstantiationService,
		themeService: IThemeService,
		protected readonly registry: CompositeRegistry<T>,
		private activeCompositeSettingsKey: string,
		private defaultCompositeId: string,
		private nameForTelemetry: string,
		private compositeCSSClass: string,
		private titleForegroundColor: string | undefined,
		id: string,
		options: IPartOptions
	) {
		super(id, options, themeService, storageService, layoutService);

		this.activeComposite = null;
		this.instantiatedCompositeItems = new Map<string, CompositeItem>();
		this.lastActiveCompositeId = storageService.get(activeCompositeSettingsKey, StorageScope.WORKSPACE, this.defaultCompositeId);
	}

	protected openComposite(id: string, focus?: boolean): Composite | undefined {

		// Check if composite already visible and just focus in that case
		if (this.activeComposite && this.activeComposite.getId() === id) {
			if (focus) {
				this.activeComposite.focus();
			}

			// Fullfill promise with composite that is being opened
			return this.activeComposite;
		}

		// Open
		return this.doOpenComposite(id, focus);
	}

	private doOpenComposite(id: string, focus: boolean = false): Composite | undefined {

		// Use a generated token to avoid race conditions from long running promises
		const currentCompositeOpenToken = defaultGenerator.nextId();
		this.currentCompositeOpenToken = currentCompositeOpenToken;

		// Hide current
		if (this.activeComposite) {
			this.hideActiveComposite();
		}

		// Update Title
		this.updateTitle(id);

		// Create composite
		const composite = this.createComposite(id, true);

		// Check if another composite opened meanwhile and return in that case
		if ((this.currentCompositeOpenToken !== currentCompositeOpenToken) || (this.activeComposite && this.activeComposite.getId() !== composite.getId())) {
			return undefined;
		}

		// Check if composite already visible and just focus in that case
		if (this.activeComposite && this.activeComposite.getId() === composite.getId()) {
			if (focus) {
				composite.focus();
			}

			this.onDidCompositeOpen.fire({ composite, focus });
			return composite;
		}

		// Show Composite and Focus
		this.showComposite(composite);
		if (focus) {
			composite.focus();
		}

		// Return with the composite that is being opened
		if (composite) {
			this.onDidCompositeOpen.fire({ composite, focus });
		}

		return composite;
	}

	protected createComposite(id: string, isActive?: boolean): Composite {

		// Check if composite is already created
		const compositeItem = this.instantiatedCompositeItems.get(id);
		if (compositeItem) {
			return compositeItem.composite;
		}

		// Instantiate composite from registry otherwise
		const compositeDescriptor = this.registry.getComposite(id);
		if (compositeDescriptor) {
			const composite = compositeDescriptor.instantiate(this.instantiationService);
			const disposable = new DisposableStore();

			// Remember as Instantiated
			this.instantiatedCompositeItems.set(id, {
				composite,
				disposable,
				progress: this._register(this.instantiationService.createInstance(CompositeProgressIndicator, this.progressBar, compositeDescriptor.id, isActive))
			});

			// Register to title area update events from the composite
			disposable.add(composite.onTitleAreaUpdate(() => this.onTitleAreaUpdate(composite.getId()), this));

			return composite;
		}

		throw new Error(`Unable to find composite with id ${id}`);
	}

	protected showComposite(composite: Composite): void {

		// Remember Composite
		this.activeComposite = composite;

		// Store in preferences
		const id = this.activeComposite.getId();
		if (id !== this.defaultCompositeId) {
			this.storageService.store(this.activeCompositeSettingsKey, id, StorageScope.WORKSPACE);
		} else {
			this.storageService.remove(this.activeCompositeSettingsKey, StorageScope.WORKSPACE);
		}

		// Remember
		this.lastActiveCompositeId = this.activeComposite.getId();

		// Composites created for the first time
		let compositeContainer = this.mapCompositeToCompositeContainer.get(composite.getId());
		if (!compositeContainer) {

			// Build Container off-DOM
			compositeContainer = $('.composite');
			addClasses(compositeContainer, this.compositeCSSClass);
			compositeContainer.id = composite.getId();

			composite.create(compositeContainer);
			composite.updateStyles();

			// Remember composite container
			this.mapCompositeToCompositeContainer.set(composite.getId(), compositeContainer);
		}

		// Fill Content and Actions
		// Make sure that the user meanwhile did not open another composite or closed the part containing the composite
		if (!this.activeComposite || composite.getId() !== this.activeComposite.getId()) {
			return undefined;
		}

		// Take Composite on-DOM and show
		const contentArea = this.getContentArea();
		if (contentArea) {
			contentArea.appendChild(compositeContainer);
		}
		show(compositeContainer);

		// Setup action runner
		this.toolBar.actionRunner = composite.getActionRunner();

		// Update title with composite title if it differs from descriptor
		const descriptor = this.registry.getComposite(composite.getId());
		if (descriptor && descriptor.name !== composite.getTitle()) {
			this.updateTitle(composite.getId(), withNullAsUndefined(composite.getTitle()));
		}

		// Handle Composite Actions
		let actionsBinding = this.mapActionsBindingToComposite.get(composite.getId());
		if (!actionsBinding) {
			actionsBinding = this.collectCompositeActions(composite);
			this.mapActionsBindingToComposite.set(composite.getId(), actionsBinding);
		}
		actionsBinding();

		// Action Run Handling
		this.telemetryActionsListener.value = this.toolBar.actionRunner.onDidRun(e => {

			// Check for Error
			if (e.error && !errors.isPromiseCanceledError(e.error)) {
				this.notificationService.error(e.error);
			}

			// Log in telemetry
			if (this.telemetryService) {
				this.telemetryService.publicLog2<WBActionExecutedEvent, WBActionExecutedClassification>('workbenchActionExecuted', { id: e.action.id, from: this.nameForTelemetry });
			}
		});

		// Indicate to composite that it is now visible
		composite.setVisible(true);

		// Make sure that the user meanwhile did not open another composite or closed the part containing the composite
		if (!this.activeComposite || composite.getId() !== this.activeComposite.getId()) {
			return;
		}

		// Make sure the composite is layed out
		if (this.contentAreaSize) {
			composite.layout(this.contentAreaSize);
		}
	}

	protected onTitleAreaUpdate(compositeId: string): void {

		// Active Composite
		if (this.activeComposite && this.activeComposite.getId() === compositeId) {

			// Title
			this.updateTitle(this.activeComposite.getId(), this.activeComposite.getTitle() || undefined);

			// Actions
			const actionsBinding = this.collectCompositeActions(this.activeComposite);
			this.mapActionsBindingToComposite.set(this.activeComposite.getId(), actionsBinding);
			actionsBinding();
		}

		// Otherwise invalidate actions binding for next time when the composite becomes visible
		else {
			this.mapActionsBindingToComposite.delete(compositeId);
		}
	}

	private updateTitle(compositeId: string, compositeTitle?: string): void {
		const compositeDescriptor = this.registry.getComposite(compositeId);
		if (!compositeDescriptor || !this.titleLabel) {
			return;
		}

		if (!compositeTitle) {
			compositeTitle = compositeDescriptor.name;
		}

		const keybinding = this.keybindingService.lookupKeybinding(compositeId);

		this.titleLabel.updateTitle(compositeId, compositeTitle, (keybinding && keybinding.getLabel()) || undefined);

		this.toolBar.setAriaLabel(nls.localize('ariaCompositeToolbarLabel', "{0} actions", compositeTitle));
	}

	private collectCompositeActions(composite: Composite): () => void {

		// From Composite
		const primaryActions: IAction[] = composite.getActions().slice(0);
		const secondaryActions: IAction[] = composite.getSecondaryActions().slice(0);

		// From Part
		primaryActions.push(...this.getActions());
		secondaryActions.push(...this.getSecondaryActions());

		// Update context
		this.toolBar.context = this.actionsContextProvider();

		// Return fn to set into toolbar
		return this.toolBar.setActions(prepareActions(primaryActions), prepareActions(secondaryActions));
	}

	protected getActiveComposite(): IComposite | null {
		return this.activeComposite;
	}

	protected getLastActiveCompositetId(): string {
		return this.lastActiveCompositeId;
	}

	protected hideActiveComposite(): Composite | undefined {
		if (!this.activeComposite) {
			return undefined; // Nothing to do
		}

		const composite = this.activeComposite;
		this.activeComposite = null;

		const compositeContainer = this.mapCompositeToCompositeContainer.get(composite.getId());

		// Indicate to Composite
		composite.setVisible(false);

		// Take Container Off-DOM and hide
		if (compositeContainer) {
			compositeContainer.remove();
			hide(compositeContainer);
		}

		// Clear any running Progress
		this.progressBar.stop().hide();

		// Empty Actions
		this.toolBar.setActions([])();
		this.onDidCompositeClose.fire(composite);

		return composite;
	}

	createTitleArea(parent: HTMLElement): HTMLElement {

		// Title Area Container
		const titleArea = append(parent, $('.composite'));
		addClass(titleArea, 'title');

		// Left Title Label
		this.titleLabel = this.createTitleLabel(titleArea);

		// Right Actions Container
		const titleActionsContainer = append(titleArea, $('.title-actions'));

		// Toolbar
		this.toolBar = this._register(new ToolBar(titleActionsContainer, this.contextMenuService, {
			actionViewItemProvider: action => this.actionViewItemProvider(action),
			orientation: ActionsOrientation.HORIZONTAL,
			getKeyBinding: action => this.keybindingService.lookupKeybinding(action.id),
			anchorAlignmentProvider: () => this.getTitleAreaDropDownAnchorAlignment()
		}));

		return titleArea;
	}

	protected createTitleLabel(parent: HTMLElement): ICompositeTitleLabel {
		const titleContainer = append(parent, $('.title-label'));
		const titleLabel = append(titleContainer, $('h2'));

		const $this = this;
		return {
			updateTitle: (id, title, keybinding) => {
				titleLabel.innerHTML = strings.escape(title);
				titleLabel.title = keybinding ? nls.localize('titleTooltip', "{0} ({1})", title, keybinding) : title;
			},

			updateStyles: () => {
				titleLabel.style.color = $this.titleForegroundColor ? $this.getColor($this.titleForegroundColor) : null;
			}
		};
	}

	updateStyles(): void {
		super.updateStyles();

		// Forward to title label
		this.titleLabel.updateStyles();
	}

	protected actionViewItemProvider(action: IAction): IActionViewItem | undefined {

		// Check Active Composite
		if (this.activeComposite) {
			return this.activeComposite.getActionViewItem(action);
		}

		return undefined;
	}

	protected actionsContextProvider(): unknown {

		// Check Active Composite
		if (this.activeComposite) {
			return this.activeComposite.getActionsContext();
		}

		return null;
	}

	createContentArea(parent: HTMLElement): HTMLElement {
		const contentContainer = append(parent, $('.content'));

		this.progressBar = this._register(new ProgressBar(contentContainer));
		this._register(attachProgressBarStyler(this.progressBar, this.themeService));
		this.progressBar.hide();

		return contentContainer;
	}

	getProgressIndicator(id: string): IProgressIndicator | null {
		const compositeItem = this.instantiatedCompositeItems.get(id);

		return compositeItem ? compositeItem.progress : null;
	}

	protected getActions(): ReadonlyArray<IAction> {
		return [];
	}

	protected getSecondaryActions(): ReadonlyArray<IAction> {
		return [];
	}

	protected getTitleAreaDropDownAnchorAlignment(): AnchorAlignment {
		return AnchorAlignment.RIGHT;
	}

	layout(width: number, height: number): void {

		// Layout contents
		this.contentAreaSize = super.layoutContents(width, height).contentSize;

		// Layout composite
		if (this.activeComposite) {
			this.activeComposite.layout(this.contentAreaSize);
		}
	}

	protected removeComposite(compositeId: string): boolean {
		if (this.activeComposite && this.activeComposite.getId() === compositeId) {
			return false; // do not remove active composite
		}

		this.mapCompositeToCompositeContainer.delete(compositeId);
		this.mapActionsBindingToComposite.delete(compositeId);
		const compositeItem = this.instantiatedCompositeItems.get(compositeId);
		if (compositeItem) {
			compositeItem.composite.dispose();
			dispose(compositeItem.disposable);
			this.instantiatedCompositeItems.delete(compositeId);
		}

		return true;
	}

	dispose(): void {
		this.mapCompositeToCompositeContainer.clear();
		this.mapActionsBindingToComposite.clear();

		this.instantiatedCompositeItems.forEach(compositeItem => {
			compositeItem.composite.dispose();
			dispose(compositeItem.disposable);
		});

		this.instantiatedCompositeItems.clear();

		super.dispose();
	}
}
