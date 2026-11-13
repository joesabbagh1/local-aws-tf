import React, { useState, useMemo } from 'react';
import { AWS_CATEGORIES, AWS_SERVICES_CATALOG } from '../data/awsCatalog';
import { useCloudStore } from '../store/useCloudStore';
import { AwsServiceIcon } from './AwsServiceIcon';
import { Search, Plus, ChevronRight, X } from 'lucide-react';
import { cn } from './ui';

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

  const filteredByCategory = useMemo(() => {
    const q = search.trim().toLowerCase();
    const map: Record<string, typeof AWS_SERVICES_CATALOG> = {};
    for (const cat of AWS_CATEGORIES) {
      const items = AWS_SERVICES_CATALOG.filter(
        (svc) =>
          svc.category === cat &&
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

  return (
    <aside className="w-64 shrink-0 h-full bg-panel border-r border-line flex flex-col select-none">
      {/* Search */}
      <div className="p-3 border-b border-line">
        <div className="relative">
          <Search className="w-3.5 h-3.5 text-fg-faint absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={`Search ${AWS_SERVICES_CATALOG.length} services`}
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
                <span className="text-[11px] font-medium truncate">{category}</span>
                <span className="ml-auto text-[11px] text-fg-faint tabular-nums">{services.length}</span>
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
                      <span className="text-[13px] text-fg shrink-0">{svc.shortName}</span>
                      <span className="text-xs text-fg-faint truncate">{secondaryName(svc.name, svc.shortName)}</span>
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
