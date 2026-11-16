import React, { useState, useMemo } from 'react';
import { AWS_CATEGORIES, AWS_SERVICES_CATALOG } from '../data/awsCatalog';
import { useCloudStore } from '../store/useCloudStore';
import { AwsServiceIcon } from './AwsServiceIcon';
import { Search, Plus, ChevronRight, X, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { IconButton, cn } from './ui';
import { emulatorSupport } from '../utils/emulatorSupport';

/** "DynamoDB NoSQL Table" → "NoSQL Table", "Internet Gateway (IGW)" → "Internet Gateway" */
function secondaryName(name: string, shortName: string): string {
  let rest = name;
  if (rest.startsWith(`${shortName} `)) rest = rest.slice(shortName.length + 1);
  return rest.replace(` (${shortName})`, '');
}

export function ServiceCatalogSidebar() {
  const [search, setSearch] = useState('');
  const [collapsedCategories, setCollapsedCategories] = useState<Record<string, boolean>>({});
  const addServiceNode = useCloudStore((s) => s.addServiceNode);
  const isOpen = useCloudStore((s) => s.isCatalogOpen);
  const setOpen = useCloudStore((s) => s.setCatalogOpen);

  const filteredByCategory = useMemo(() => {
    const q = search.trim().toLowerCase();
    const map: Record<string, typeof AWS_SERVICES_CATALOG> = {};
    for (const cat of AWS_CATEGORIES) {
      const items = AWS_SERVICES_CATALOG.filter(
        (svc) =>
          svc.category === cat &&
          !svc.deprecated &&
          (!q ||
            svc.name.toLowerCase().includes(q) ||
            svc.shortName.toLowerCase().includes(q) ||
            svc.serviceCode.toLowerCase().includes(q) ||
            svc.terraformResourceType.toLowerCase().includes(q) ||
            svc.description.toLowerCase().includes(q))
      );
      if (items.length > 0) {
        map[cat] = items;
      }
    }
    return map;
  }, [search]);

  const onDragStart = (event: React.DragEvent, serviceType: string) => {
    event.dataTransfer.setData('application/localcloud-service', serviceType);
    event.dataTransfer.effectAllowed = 'move';
  };

  const toggleCategory = (cat: string) => {
    setCollapsedCategories((prev) => ({
      ...prev,
      [cat]: !prev[cat],
    }));
  };

  if (!isOpen) {
    return (
      <aside className="w-10 shrink-0 h-full bg-panel border-r border-line flex flex-col items-center py-3 select-none">
        <IconButton onClick={() => setOpen(true)} title="Show services (⌘B)">
          <PanelLeftOpen className="w-4 h-4" />
        </IconButton>
      </aside>
    );
  }

  return (
    <aside className="w-64 shrink-0 h-full bg-panel border-r border-line flex flex-col select-none">
      {/* Search */}
      <div className="p-3 border-b border-line flex items-center gap-1.5">
        <div className="relative flex-1 min-w-0">
          <Search className="w-3.5 h-3.5 text-fg-faint absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={`Search ${AWS_SERVICES_CATALOG.filter((s) => !s.deprecated).length} services`}
            className="w-full h-8 bg-base border border-line hover:border-line-strong focus:border-accent/70 rounded-md pl-8 pr-7 text-xs text-fg placeholder:text-fg-faint focus:outline-none transition-colors"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              title="Clear search"
              className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 rounded text-fg-faint hover:text-fg"
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>
        <IconButton onClick={() => setOpen(false)} title="Hide services (⌘B)" className="-mr-1">
          <PanelLeftClose className="w-4 h-4" />
        </IconButton>
      </div>

      {/* Categories */}
      <div className="flex-1 overflow-y-auto py-1.5">
        {Object.entries(filteredByCategory).map(([category, services]) => {
          const isCollapsed = collapsedCategories[category] && !search;
          return (
            <div key={category} className="mb-1">
              <button
                type="button"
                onClick={() => toggleCategory(category)}
                className="w-full h-7 px-3 flex items-center gap-1.5 text-left text-fg-muted hover:text-fg transition-colors"
              >
                <ChevronRight
                  className={cn('w-3 h-3 shrink-0 transition-transform', !isCollapsed && 'rotate-90')}
                />
                <span className="text-[12.5px] font-medium truncate">{category}</span>
                <span className="ml-auto text-[12.5px] text-fg-faint tabular-nums">{services.length}</span>
              </button>

              {!isCollapsed && (
                <div className="px-1.5">
                  {services.map((svc) => (
                    <div
                      key={svc.typeId}
                      draggable
                      onDragStart={(e) => onDragStart(e, svc.typeId)}
                      onClick={() => addServiceNode(svc.typeId)}
                      title={`${svc.name}\n${svc.terraformResourceType}\nDrag onto the canvas or click to add`}
                      className="group h-8 px-1.5 flex items-center gap-2.5 rounded-md hover:bg-raised cursor-grab active:cursor-grabbing transition-colors"
                    >
                      <span className="w-5 flex justify-center shrink-0" style={{ color: svc.color }}>
                        <AwsServiceIcon iconName={svc.iconName} className="w-3.5 h-3.5" />
                      </span>
                      <span className="text-[14px] text-fg shrink-0">{svc.shortName}</span>
                      <span className="text-xs text-fg-faint truncate">{secondaryName(svc.name, svc.shortName)}</span>
                      {emulatorSupport(svc).level === 'fails' && (
                        <span
                          className="w-1.5 h-1.5 rounded-full bg-warn shrink-0"
                          title={`Fails on the emulator in tests:\n${emulatorSupport(svc).errors[0] || ''}`}
                        />
                      )}
                      <Plus className="w-3.5 h-3.5 ml-auto shrink-0 text-fg-muted opacity-0 group-hover:opacity-100 transition-opacity" />
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}

        {Object.keys(filteredByCategory).length === 0 && (
          <div className="py-12 px-4 text-center text-xs text-fg-faint">
            No services match “{search}”
          </div>
        )}
      </div>
    </aside>
  );
}
