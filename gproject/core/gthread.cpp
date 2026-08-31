#include "gthread.h"
void Gthread::setUsed(int _used){
        used = _used;
    }
    
void Gthread::setEnable(bool _enable){
        enable = _enable;
    }

void Gthread::setName(string _name){
        name = _name;
    }


bool Gthread::getUsed(){
    return used;
}
bool Gthread::getEnable(){
    return enable;
}
string Gthread::getName(){
    return name;
}  